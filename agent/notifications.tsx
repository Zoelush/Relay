import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export type Notification = {
  id: string;
  /** A mention in a note, (phase 08 C2b) an incident Zoe's monitors opened, or (phase 11 W4) a failing workflow. */
  kind: "mention" | "zoe_incident" | "workflow_alert" | "webhook_disabled";
  workflowId?: string | null;
  conversationId: string | null;
  conversationTitle: string | null;
  actorName: string | null;
  incidentId: string | null;
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
  onIncident,
  onWorkflowAlert,
  onWebhook,
  onClose,
  onError,
}: {
  onOpen: (conversationId: string) => void;
  /** Opens Zoe's incidents. */
  onIncident: () => void;
  /** Opens a failing workflow's runs (phase 11 W4). */
  onWorkflowAlert?: (workflowId: string) => void;
  /** Opens Settings › Developers › Webhooks (phase 15 D3). */
  onWebhook?: () => void;
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
                    if (n.kind === "zoe_incident") onIncident();
                    else if (n.kind === "workflow_alert") onWorkflowAlert?.(n.workflowId ?? "");
                    else if (n.kind === "webhook_disabled") onWebhook?.();
                    else if (n.conversationId) onOpen(n.conversationId);
                  }}
                >
                  <strong>
                    {n.kind === "zoe_incident"
                      ? "Incident: Zoe's behaviour changed sharply"
                      : n.kind === "workflow_alert"
                        ? "A workflow keeps failing"
                      : n.kind === "webhook_disabled"
                        ? "A webhook was turned off"
                      : `${n.actorName} mentioned you in ${n.conversationTitle || "a conversation"}`}
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
