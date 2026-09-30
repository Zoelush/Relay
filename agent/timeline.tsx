import { useState } from "react";
import { LockKeyhole, Paperclip } from "lucide-react";
import { RichText } from "../lib/rich-view";

export type TimelinePart = {
  id: string;
  kind: string;
  audience: string;
  body: string;
  author_type: string;
  author_id?: string;
  supersedes_id?: string;
  created_at: string;
  data: Record<string, unknown> & {
    authorName?: string;
    attachmentId?: string;
    name?: string;
    deleted?: boolean;
  };
};
export type Directory = {
  teammates: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  /** Ticket states across types, named "Type: State"; empty when tickets are off. */
  ticketStates?: { id: string; name: string }[];
};
const MESSAGES = new Set([
  "customer_message",
  "teammate_reply",
  "internal_note",
  "ai_reply",
  "attachment",
]);
const when = (iso: unknown, timeZone?: unknown) =>
  typeof iso === "string"
    ? new Date(iso).toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        ...(typeof timeZone === "string"
          ? { timeZone, timeZoneName: "short" }
          : {}),
      })
    : "";
const pick = (list: { id: string; name: string }[], id: unknown) =>
  list.find((x) => x.id === id)?.name ?? (id ? String(id) : "");

/** One line of text for a system part. Every kind written by the conversation core is covered. */
export function describePart(p: TimelinePart, dir: Directory): string {
  const d = p.data;
  const who =
    p.author_type === "system"
      ? "Relay"
      : p.author_type === "contact"
        ? "Customer"
        : pick(dir.teammates, p.author_id) || "A teammate";
  switch (p.kind) {
    case "state_change":
      if (d.to === "snoozed")
        return `${who} snoozed this until ${when(d.until, d.timezone)}${d.unassignOnWake ? ", unassigning when it wakes" : ""}`;
      if (d.woke) return "Snooze ended; the conversation is open again";
      if (d.to === "closed") return `${who} closed this conversation`;
      return `${who} reopened this conversation`;
    case "assignment_change": {
      const after = (d.after ?? {}) as {
        teammate?: string;
        team?: string | null;
      };
      const target = [
        after.teammate ? pick(dir.teammates, after.teammate) : "",
        after.team ? "team " + pick(dir.teams, after.team) : "",
      ]
        .filter(Boolean)
        .join(" and ");
      if (d.reason === "snooze_wake") return "Unassigned when the snooze ended";
      return target
        ? `${who} assigned this to ${target}`
        : `${who} unassigned this conversation`;
    }
    case "priority_change":
      return d.after
        ? `${who} marked this as priority`
        : `${who} removed priority`;
    case "tag_change":
      return `${who} ${d.action === "tag_remove" ? "removed" : "added"} the tag ${pick(dir.tags, d.tagId)}`;
    case "participant_change":
      return `${who} ${d.action === "participant_remove" ? "removed" : "added"} a participant`;
    case "attribute_change":
      if (d.attribute === "title")
        return `${who} renamed this to “${String(d.after ?? "")}”`;
      if (d.attribute === "topics")
        return `${who} set topics: ${(Array.isArray(d.after) ? d.after : []).join(", ") || "none"}`;
      return `${who} updated a conversation attribute`;
    case "merge_marker":
      return d.into
        ? "This conversation was merged into another conversation"
        : "Another conversation was merged into this one";
    case "rating":
      return `Customer rated this conversation ${String(d.value)} out of 5`;
    case "channel_handover":
      return `Conversation moved to ${String(d.channel ?? "another channel")}`;
    case "system_event":
      if (d.event === "ticket_created")
        return `${who} converted this to ${(d.type as { name?: string })?.name ?? "a"} ticket #${String(d.number)} (${(d.state as { name?: string })?.name ?? ""})`;
      if (d.event === "ticket_state_change")
        return `${who} moved the ticket to ${(d.to as { name?: string })?.name ?? "another state"}`;
      if (d.event === "ticket_type_change") {
        const lost = (Array.isArray(d.lost) ? d.lost : []) as {
          name: string;
        }[];
        return (
          `${who} changed the ticket type to ${(d.to as { name?: string })?.name ?? "another type"}` +
          (lost.length ? `; cleared ${lost.map((f) => f.name).join(", ")}` : "")
        );
      }
      if (d.event === "human_joined")
        return `${pick(dir.teammates, d.teammateId) || "A teammate"} joined the conversation`;
      return "Conversation activity";
    default:
      return p.body || "Conversation activity";
  }
}

/** Inline images load through the authenticated agent route, as previews. */
const agentImage = (image: { attachmentId: string; alt?: string }) => (
  // Authenticated attachment proxy: next/image would fetch without the session.
  // eslint-disable-next-line @next/next/no-img-element
  <img
    src={
      "/api/agent/attachment/content?preview=true&id=" +
      encodeURIComponent(image.attachmentId)
    }
    alt={image.alt ?? ""}
    loading="lazy"
  />
);
function Message({ p, edited }: { p: TimelinePart; edited: boolean }) {
  const internal = p.audience === "internal" || p.kind === "internal_note";
  return (
    <article
      data-part-id={p.id}
      className={internal ? "pg-message pg-note" : "pg-message"}
    >
      <header>
        {internal && <LockKeyhole size={13} />}
        <strong>
          {internal
            ? "Internal note · Team only"
            : p.author_type === "contact"
              ? "Customer"
              : (p.data.authorName ??
                (p.author_type === "ai" ? "AI agent" : "Teammate"))}
        </strong>
        {edited && !p.data.deleted && (
          <small className="pg-edited">Edited</small>
        )}
      </header>
      {p.data.deleted ? (
        <p>This part was deleted.</p>
      ) : p.data.doc ? (
        <RichText doc={p.data.doc} fallback={p.body} image={agentImage} />
      ) : (
        <p>{p.body}</p>
      )}
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
          {internal ? " · Team only" : ""}
        </a>
      )}
    </article>
  );
}

function EventRun({ parts, dir }: { parts: TimelinePart[]; dir: Directory }) {
  const [open, setOpen] = useState(false);
  if (parts.length === 1)
    return (
      <p className="pg-event" data-event-id={parts[0].id}>
        {describePart(parts[0], dir)}
      </p>
    );
  return (
    <div className="pg-event-run">
      <button
        className="pg-event"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
      >
        {open ? "Hide" : "Show"} {parts.length} updates
      </button>
      {open &&
        parts.map((p) => (
          <p key={p.id} className="pg-event" data-event-id={p.id}>
            {describePart(p, dir)}
          </p>
        ))}
    </div>
  );
}

/**
 * Messages render as cards; consecutive system events collapse into one expandable line.
 * Superseded parts are hidden and their replacements marked as edited.
 */
export function Timeline({
  parts,
  dir,
}: {
  parts: TimelinePart[];
  dir: Directory;
}) {
  const superseded = new Set(parts.map((p) => p.supersedes_id).filter(Boolean));
  const visible = parts.filter((p) => !superseded.has(p.id));
  const groups: (TimelinePart | TimelinePart[])[] = [];
  for (const p of visible) {
    const last = groups.at(-1);
    if (MESSAGES.has(p.kind)) groups.push(p);
    else if (Array.isArray(last)) last.push(p);
    else groups.push([p]);
  }
  return (
    <>
      {groups.map((g) =>
        Array.isArray(g) ? (
          <EventRun key={g[0].id} parts={g} dir={dir} />
        ) : (
          <Message key={g.id} p={g} edited={!!g.supersedes_id} />
        ),
      )}
    </>
  );
}
