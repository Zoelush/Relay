import { useCallback, useEffect, useRef, useState } from "react";
import { api, InboxError } from "./api";
import { normalizeDoc, type RichDoc } from "../lib/rich-doc";

type Mode = "reply" | "note";
type ServerDraft = { doc: RichDoc; version: string };
export type DraftState = {
  doc: RichDoc | null;
  /** Server version this content was based on; null when no server draft exists. */
  version: string | null;
  status: "idle" | "saving" | "saved" | "offline" | "conflict";
  /** The other tab's or device's draft, while a conflict waits for a choice. */
  theirs?: { doc: RichDoc | null; version: string | null };
};
const EMPTY: DraftState = { doc: null, version: null, status: "idle" };
const AUTOSAVE_MS = 800,
  RETRY_MS = 5000;
/** Server documents come back from jsonb with keys reordered; rebuild them for comparison. */
const canonical = (doc: RichDoc | null | undefined): RichDoc | null => {
  if (!doc) return null;
  try {
    return normalizeDoc(doc);
  } catch {
    return null;
  }
};
const keyOf = (conversationId: string, mode: Mode) =>
  conversationId + ":" + mode;
const split = (key: string) => {
  const at = key.lastIndexOf(":");
  return { conversationId: key.slice(0, at), mode: key.slice(at + 1) as Mode };
};

/**
 * Server-backed drafts for the signed-in teammate. Edits autosave after a pause, carrying the
 * version they started from. A newer save from another tab returns a conflict for the teammate
 * to resolve. While saving fails, the draft stays in this tab's memory and retries; nothing is
 * written to browser storage. `onRestore` tells the composer to reload a key's content.
 */
export function useDrafts(onRestore: (key: string) => void) {
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const current = useRef(drafts);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const saving = useRef(new Set<string>());
  // Bumped when a draft is sent or reset, so a save already in flight is ignored.
  const epoch = useRef(new Map<string, number>());
  const restore = useRef(onRestore);
  // Timers call the latest `save` through this ref (it reschedules itself).
  const saveRef = useRef<(key: string, keepalive?: boolean) => Promise<void>>(
    async () => {},
  );
  const later = useCallback(
    (key: string, ms: number) =>
      timers.current.set(
        key,
        setTimeout(() => void saveRef.current(key), ms),
      ),
    [],
  );
  useEffect(() => {
    current.current = drafts;
    restore.current = onRestore;
  });
  const update = useCallback((key: string, next: Partial<DraftState>) => {
    current.current = {
      ...current.current,
      [key]: { ...(current.current[key] ?? EMPTY), ...next },
    };
    setDrafts(current.current);
  }, []);
  const save = useCallback(
    async (key: string, keepalive = false) => {
      clearTimeout(timers.current.get(key));
      const entry = current.current[key];
      if (!entry || entry.status === "conflict") return;
      if (saving.current.has(key)) {
        later(key, AUTOSAVE_MS);
        return;
      }
      if (entry.doc === null && entry.version === null) return;
      const started = epoch.current.get(key) ?? 0,
        doc = entry.doc;
      saving.current.add(key);
      update(key, { status: "saving" });
      try {
        const { conversationId, mode } = split(key);
        const result = await api<{ version: string | null }>(
          "drafts",
          {
            conversationId,
            mode,
            doc,
            baseVersion: entry.version,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          undefined,
          { keepalive },
        );
        if ((epoch.current.get(key) ?? 0) !== started) return;
        const changed = current.current[key]?.doc !== doc;
        update(key, {
          version: result.version,
          status: changed ? "idle" : "saved",
        });
        if (changed) later(key, AUTOSAVE_MS);
      } catch (e) {
        if ((epoch.current.get(key) ?? 0) !== started) return;
        if (e instanceof InboxError && e.code === "DRAFT_CONFLICT") {
          const theirs = (e.data as { draft: ServerDraft | null }).draft;
          update(key, {
            status: "conflict",
            theirs: {
              doc: canonical(theirs?.doc),
              version: theirs?.version ?? null,
            },
          });
        } else {
          // Offline or failing: keep the draft here and try again.
          update(key, { status: "offline" });
          later(key, RETRY_MS);
        }
      } finally {
        saving.current.delete(key);
      }
    },
    [update, later],
  );
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  /** Records an edit and schedules an autosave. */
  const edit = useCallback(
    (conversationId: string, mode: Mode, doc: RichDoc | null) => {
      const key = keyOf(conversationId, mode);
      // Editor normalisation (not typing) can report the same document again: not an edit.
      if (
        JSON.stringify(current.current[key]?.doc ?? null) ===
        JSON.stringify(doc)
      )
        return;
      update(key, {
        doc,
        status:
          current.current[key]?.status === "conflict" ? "conflict" : "idle",
      });
      clearTimeout(timers.current.get(key));
      later(key, AUTOSAVE_MS);
    },
    [update, later],
  );
  /** Loads the teammate's server drafts for a conversation, keeping any unsaved local edit. */
  const load = useCallback(
    async (conversationId: string) => {
      const server = await api<Partial<Record<Mode, ServerDraft>>>(
        "drafts?" + new URLSearchParams({ conversation: conversationId }),
      );
      for (const mode of ["reply", "note"] as Mode[]) {
        const key = keyOf(conversationId, mode),
          local = current.current[key];
        // Keep unsaved local text; anything else (nothing typed, or already saved) is replaced.
        if (local && local.doc !== null && local.status !== "saved") continue;
        const s = server[mode];
        update(key, {
          doc: canonical(s?.doc),
          version: s?.version ?? null,
          status: s ? "saved" : "idle",
        });
        restore.current(key);
      }
    },
    [update],
  );
  /** The draft was sent: the server deleted it in the same transaction. */
  const sent = useCallback(
    (conversationId: string, mode: Mode) => {
      const key = keyOf(conversationId, mode);
      clearTimeout(timers.current.get(key));
      epoch.current.set(key, (epoch.current.get(key) ?? 0) + 1);
      update(key, {
        doc: null,
        version: null,
        status: "idle",
        theirs: undefined,
      });
    },
    [update],
  );
  /** Resolves a conflict by keeping this tab's text, or taking the other version. */
  const resolve = useCallback(
    (key: string, choice: "mine" | "theirs") => {
      const entry = current.current[key];
      if (!entry?.theirs) return;
      if (choice === "theirs") {
        update(key, {
          doc: entry.theirs.doc,
          version: entry.theirs.version,
          status: "saved",
          theirs: undefined,
        });
        restore.current(key);
      } else {
        update(key, {
          version: entry.theirs.version,
          status: "idle",
          theirs: undefined,
        });
        void save(key);
      }
    },
    [save, update],
  );
  const reset = useCallback(() => {
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
    for (const key of Object.keys(current.current))
      epoch.current.set(key, (epoch.current.get(key) ?? 0) + 1);
    current.current = {};
    setDrafts({});
  }, []);
  /** Retries every draft that failed while offline, for example after reconnecting. */
  const retry = useCallback(() => {
    for (const [key, d] of Object.entries(current.current))
      if (d.status === "offline") void save(key);
  }, [save]);
  // Leaving or refreshing the page sends pending saves at once instead of losing the last pause.
  useEffect(() => {
    const t = timers.current;
    const flush = () => {
      for (const [key, d] of Object.entries(current.current))
        if (d.status === "idle" || d.status === "offline")
          void saveRef.current(key, true);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      for (const timer of t.values()) clearTimeout(timer);
    };
  }, []);
  return { drafts, edit, load, sent, resolve, reset, retry, keyOf };
}
