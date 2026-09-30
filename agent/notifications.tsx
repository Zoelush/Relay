import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export type Notification = {
  id: string;
  kind: "mention";
  conversationId: string;
  conversationTitle: string;
  actorName: string;
  excerpt: string;
  createdAt: string;
  readAt: string | null;
};

/**
 * The signed-in teammate's notifications. Opening one goes to its conversation and marks it
 * read. Only this teammate's notifications are ever returned by the server.
 */
export function NotificationsPanel({
  onOpen,
  onClose,
  onError,
}: {
  onOpen: (conversationId: string) => void;
  onClose: () => void;
  onError: (e: unknown) => void;
}) {
  const [items, setItems] = useState<Notification[] | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    api<{ items: Notification[] }>("notifications")
      .then((r) => setItems(r.items))
      .catch(onError);
  }, [onError]);
  useEffect(() => {
    if (items) first.current?.focus();
  }, [items]);
  const markRead = (body: Record<string, unknown>) =>
    api("notifications", { action: "read", ...body }).catch(onError);
  return (
    <div
      className="pg-modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
        className="pg-dialog"
      >
        <header className="pg-notifications-head">
          <h2>Notifications</h2>
          <button
            disabled={!items?.some((n) => !n.readAt)}
            onClick={() => {
              void markRead({ all: true });
              setItems(
                (list) =>
                  list?.map((n) => ({
                    ...n,
                    readAt: n.readAt ?? new Date().toISOString(),
                  })) ?? null,
              );
            }}
          >
            Mark all as read
          </button>
        </header>
        {!items ? (
          <p className="pg-empty">Loading…</p>
        ) : !items.length ? (
          <p className="pg-empty">
            When a teammate mentions you or your team in a note, it appears
            here.
          </p>
        ) : (
          <ul className="pg-notifications">
            {items.map((n, i) => (
              <li key={n.id}>
                <button
                  ref={i === 0 ? first : undefined}
                  className={n.readAt ? "" : "unread"}
                  onClick={() => {
                    if (!n.readAt) void markRead({ ids: [n.id] });
                    onClose();
                    onOpen(n.conversationId);
                  }}
                >
                  <strong>
                    {n.actorName} mentioned you in{" "}
                    {n.conversationTitle || "a conversation"}
                  </strong>
                  <span>{n.excerpt}</span>
                  <time dateTime={n.createdAt}>
                    {new Date(n.createdAt).toLocaleString(undefined, {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
