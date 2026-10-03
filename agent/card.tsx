import { Flag, Mail, MessageCircle, MessageSquare, Phone } from "lucide-react";
import { SlaBadge } from "./sla";
import type { MessagePreview } from "../server/conversations";

/**
 * A conversation in the list (docs/AGENT_CARDS_AND_COMPOSER.md), after Intercom's cards: who and
 * how long ago; the channel and title; the latest message; then the SLA timer, priority and the
 * assignee. Unread conversations are marked with a dot and a bold name.
 */
export type CardRow = {
  id: string;
  title: string;
  status: string;
  channel: string;
  assigned: string;
  name?: string;
  priority?: boolean;
  unread?: boolean;
  activity_at?: string;
  updated_at?: string;
  sla_next_due_at?: string | null;
  sla_overdue?: boolean;
  /** The AI agent's state (phase 08 A2a). */
  ai_state?: string | null;
  preview?: MessagePreview | null;
};
/** How the AI agent's state reads on a card and in the header. */
export const AI_STATE_LABELS: Record<string, string> = {
  pending: "AI: waiting on customer",
  escalated: "AI: escalated",
  needs_input: "AI: needs teammate",
  resolved: "AI: resolved",
};
/** Fixed for the virtual list's arithmetic (and J/K scrolling); keep in step with the CSS. */
export const CARD_HEIGHT = 112;

export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (
    words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words.at(-1)![0]
  ).toUpperCase();
}
/** "now", "5m", "3h", "2d", then the date. */
export function ago(iso: string | undefined, now = Date.now()) {
  if (!iso) return "";
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}
function ChannelIcon({ channel }: { channel: string }) {
  const c = channel.toLowerCase();
  const Icon = c.includes("mail")
    ? Mail
    : c.includes("phone") || c.includes("sms")
      ? Phone
      : c.includes("messenger") || c.includes("chat")
        ? MessageCircle
        : MessageSquare;
  return <Icon size={13} aria-hidden="true" className="pg-card-channel" />;
}
const FROM: Record<MessagePreview["from"], string> = {
  customer: "",
  teammate: "",
  ai: "AI agent",
  note: "Note",
};

export function ConversationCard({
  row,
  selected,
  assignee,
  me,
  onOpen,
  onPrefetch,
}: {
  row: CardRow;
  selected: boolean;
  /** The assignee's name, when someone is assigned. */
  assignee?: string;
  /** The signed-in teammate, whose own replies read "You". */
  me?: string;
  onOpen: () => void;
  onPrefetch?: () => void;
}) {
  const name = row.name || "Customer";
  const when = row.activity_at ?? row.updated_at;
  const p = row.preview;
  const label = p
    ? FROM[p.from] || (me && p.authorId === me ? "You" : p.author) || ""
    : "";
  return (
    <button
      className={
        "pg-row pg-card" +
        (selected ? " selected" : "") +
        (row.unread ? " unread" : "")
      }
      onClick={onOpen}
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
    >
      <span className="pg-avatar" aria-hidden="true">
        {initials(name)}
      </span>
      <span className="pg-card-body">
        <span className="pg-card-top">
          <strong>{name}</strong>
          {row.unread && (
            <span className="pg-card-unread" title="Unread">
              <span className="pg-visually-hidden">Unread</span>
            </span>
          )}
          <time
            dateTime={when}
            title={when ? new Date(when).toLocaleString() : undefined}
          >
            {ago(when)}
          </time>
        </span>
        <span className="pg-card-line">
          <ChannelIcon channel={row.channel} />
          <span className="pg-row-title">{row.title || "Conversation"}</span>
        </span>
        <span
          className={"pg-card-preview" + (p?.from === "note" ? " note" : "")}
        >
          {p ? (
            <>
              {label && <span className="pg-card-from">{label}: </span>}
              {p.text || "…"}
            </>
          ) : (
            <span className="pg-card-empty">No messages yet</span>
          )}
        </span>
        <span className="pg-card-meta">
          <SlaBadge
            dueAt={row.sla_next_due_at ?? null}
            overdue={!!row.sla_overdue}
            chip
          />
          {row.ai_state && AI_STATE_LABELS[row.ai_state] && (
            <span className="pg-card-ai" data-state={row.ai_state}>
              {AI_STATE_LABELS[row.ai_state]}
            </span>
          )}
          {row.priority && (
            <span className="pg-card-priority" title="Priority">
              <Flag size={12} aria-hidden="true" fill="currentColor" />
              <span className="pg-visually-hidden">Priority</span>
            </span>
          )}
          {row.assigned && (
            <span
              className="pg-card-assignee"
              title={`Assigned to ${assignee ?? "a teammate"}`}
            >
              <span aria-hidden="true">{initials(assignee ?? "?")}</span>
              <span className="pg-visually-hidden">
                Assigned to {assignee ?? "a teammate"}
              </span>
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
