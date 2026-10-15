import { createContext, useContext, useEffect, useState } from "react";
import { channelLabel, DELIVERY_LABELS, type DeliveryStatus } from "../lib/channels";
import { EmailView } from "./email-view";
import { SideReply } from "./side-conversations";
import { LockKeyhole, Paperclip, Sparkles } from "lucide-react";
import { api } from "./api";
import { RichText } from "../lib/rich-view";
import { initials } from "./card";
import { hueOf, useAgentName, ZoeMark } from "./colour";
import { languageName, type Voice } from "../lib/zoe-voice";
import { voiceSummary } from "./zoe-labels";
import { GUARD_NAMES, redactionWords } from "./zoe-guidance";

export type TimelinePart = {
  id: string;
  kind: string;
  audience: string;
  body: string;
  author_type: string;
  author_id?: string;
  conversation_id?: string;
  supersedes_id?: string;
  created_at: string;
  /** Phase 12: the channel it arrived on or was sent on. */
  channel?: string;
  data: Record<string, unknown> & {
    authorName?: string;
    attachmentId?: string;
    name?: string;
    deleted?: boolean;
    /** Phase 09 D3: a write Zoe asked a teammate to approve. */
    aiApproval?: { id?: string };
  };
};
const SLA_NAMES: Record<string, string> = {
  first_response: "First response",
  next_response: "Next response",
  time_to_close: "Time to close",
  time_to_resolve: "Time to resolve",
};
export type Directory = {
  teammates: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  /** Archived tags are kept for names in history; pickers leave them out (see `activeTags`). */
  tags: { id: string; name: string; archived?: boolean }[];
  /** Ticket states across types, named "Type: State"; empty when tickets are off. */
  ticketStates?: { id: string; name: string }[];
  /** The AI agent's name (Zoe unless renamed; Z1). */
  agentName?: string;
};
/** Z3a: which specialist gave each of Zoe's replies, by reply part id. */
const EMPTY = new Map<string, string>();
const ReplySpecialists = createContext<Map<string, string>>(EMPTY);
/** Phase 12 E1: how each reply was delivered on its channel, by part id. */
type Delivery = { id: string; status: DeliveryStatus; error: string };
const NO_DELIVERIES = new Map<string, Delivery>();
const Deliveries = createContext<Map<string, Delivery>>(NO_DELIVERIES);
/** E4: read the deliveries again (after a held draft is sent or discarded). */
const ReloadDeliveries = createContext<() => void>(() => {});
/** E4: a side conversation's message, shown as a message (team only), not folded into events. */
const isSide = (p: { kind: string; data: Record<string, unknown> }) => p.kind === "system_event" && p.data.event === "side_conversation";
type Copies = { to?: string[]; cc?: string[]; bcc?: string[]; subject?: string };
/** E4: who an email was to and copied to, on one line. */
function recipients(e: Copies, withTo: boolean) {
  const line = [
    ...(withTo && e.to?.length ? [`To ${e.to.join(", ")}`] : []),
    ...(e.cc?.length ? [`Cc ${e.cc.join(", ")}`] : []),
    ...(e.bcc?.length ? [`Bcc ${e.bcc.join(", ")}`] : []),
  ];
  return line.join(" · ");
}
export const MESSAGES = new Set([
  "customer_message",
  "teammate_reply",
  "internal_note",
  "ai_reply",
  "attachment",
  // Phase 11 W3: a workflow's message to the customer.
  "workflow_message",
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
/** The tags that can be added: archived ones stay on conversations but aren't added again. */
export const activeTags = (dir: Pick<Directory, "tags">) =>
  dir.tags.filter((t) => !t.archived);
/** A tag's name in a picker, marked when archived (it can still be removed). */
export const tagLabel = (t: Directory["tags"][number]) =>
  t.archived ? `${t.name} (archived)` : t.name;

const CALL_ENDS: Record<string, string> = { completed: "ended", busy: "not answered (busy)", no_answer: "not answered", failed: "failed", canceled: "hung up before it was answered" };
/** Seconds as m:ss, for a call's length and its transcript's lines. */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function describePart(p: TimelinePart, dir: Directory): string {
  const d = p.data;
  const who =
    p.author_type === "system"
      ? // Phase 11: a workflow's change names the workflow.
        typeof d.workflowName === "string"
        ? `Workflow “${d.workflowName}”`
        : "Relay"
      : p.author_type === "contact"
        ? "Customer"
        : pick(dir.teammates, p.author_id) || "A teammate";
  switch (p.kind) {
    case "state_change":
      if (d.to === "snoozed")
        return `${who} snoozed this until ${when(d.until, d.timezone)}${d.unassignOnWake ? ", unassigning when it wakes" : ""}`;
      if (d.woke) return "Snooze ended; the conversation is open again";
      if (d.to === "closed") return `${who} closed this conversation`;
      // A conversation's first state is written with no "from" when it starts.
      if (d.from == null) return "The conversation started";
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
      // Phase 12 E9: a call's end, its transfer, and its transcript's lines (team only).
      if (d.event === "call_ended")
        return `Call ${CALL_ENDS[String(d.status)] ?? "ended"}${typeof d.duration === "number" && d.duration > 0 ? ` after ${clock(d.duration)}` : ""}`;
      if (d.event === "call_transferred")
        return `${String(d.name ?? "A teammate")} took the call`;
      if (d.event === "call_transcript")
        return `Transcript ${clock(Number(d.start ?? 0))}: ${String(d.text ?? "")}`;
      if (d.event === "sla_breached")
        return `${SLA_NAMES[String(d.metric)] ?? "SLA"} SLA breached (${(d.policy as { name?: string })?.name ?? "policy"})`;
      if (d.event === "ticket_status")
        return `Customer sees: ticket #${String(d.number)} (${String(d.typeName)}): ${String(d.label)}`;
      if (d.event === "ticket_linked")
        return `${who} linked ${d.category === "tracker" ? "tracker" : "back-office ticket"} #${String(d.number)} (${(d.type as { name?: string })?.name ?? ""})`;
      if (d.event === "ticket_unlinked")
        return `${who} unlinked ticket #${String(d.number)}`;
      if (d.event === "conversation_linked")
        return `${who} linked the conversation “${String(d.title ?? "")}”`;
      if (d.event === "conversation_unlinked")
        return `${who} unlinked the conversation “${String(d.title ?? "")}”`;
      if (d.event === "linked_ticket_state")
        return `Linked ticket #${String(d.number)} (${(d.type as { name?: string })?.name ?? ""}) moved to ${(d.state as { name?: string })?.name ?? ""}`;
      if (d.event === "tracker_broadcast")
        return `${who} broadcast an update to the linked conversations`;
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
      if (d.event === "help_context") {
        const article = d.article as { title?: string } | undefined;
        const searched = typeof d.searched === "string" ? d.searched : "";
        return [
          searched && `Customer searched the help center for “${searched}”`,
          article &&
            `Customer read “${String(article.title ?? "")}”${d.feedback === "not_helpful" ? " and said it didn't help" : ""}`,
        ]
          .filter(Boolean)
          .join(" · ");
      }
      // The resolution ledger (phase 08 A3).
      if (d.event === "ai_resolved")
        return d.rule === "confirmed"
          ? `Resolved by ${dir.agentName ?? "Zoe"}: the customer said the answer helped`
          : `Resolved by ${dir.agentName ?? "Zoe"}: no reply within ${Number(d.windowHours)} hours of her answer`;
      if (d.event === "ai_resolution_reversed")
        return "AI resolution reversed: handed to the team within the resolution window";
      if (d.event === "human_joined")
        return `${pick(dir.teammates, d.teammateId) || "A teammate"} joined the conversation`;
      // Phase 12 E2: automatic email (an auto-reply, a bounce), kept for teammates only.
      // E4: a side conversation's message (shown as a message; this is its one-line form).
      if (d.event === "side_conversation")
        return d.direction === "in"
          ? `Side conversation: an email from ${String((d.from as { address?: string } | undefined)?.address ?? "someone")}`
          : `Side conversation: ${who} emailed ${Array.isArray(d.to) ? d.to.join(", ") : "someone"}`;
      if (d.event === "automatic_reply")
        return d.kind === "bounce"
          ? `A delivery problem was reported by ${String(d.channel ?? "email")}${d.reason ? `: ${String(d.reason)}` : ""}`
          : `An automatic reply arrived by ${String(d.channel ?? "email")}${d.subject ? ` (“${String(d.subject)}”)` : ""}`;
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
/**
 * A message as a chat bubble, after Intercom's: the customer's on the left in a neutral colour,
 * the team's (replies, AI replies and internal notes) on the right, replies in olive and notes
 * in yellow, each with the writer's initials beside it.
 */
function Message({
  p,
  edited,
  customer,
}: {
  p: TimelinePart;
  edited: boolean;
  customer?: string;
}) {
  const internal = p.audience === "internal" || p.kind === "internal_note";
  const fromCustomer = p.author_type === "contact";
  // Zoe (Z1): her name and mark on her replies and handover notes; and (Z3a) the specialist.
  const agentName = useAgentName();
  const specialist = useContext(ReplySpecialists).get(p.id);
  const delivery = useContext(Deliveries).get(p.id);
  const reloadDeliveries = useContext(ReloadDeliveries);
  const [full, setFull] = useState(false);
  const [deciding, setDeciding] = useState("");
  // E4: a side conversation's message: from the team (out) or the other side (in).
  const side = isSide(p) ? (p.data as { sideId: string; direction: "out" | "in"; subject?: string; to?: string[]; from?: { address: string; name: string }; text?: string; automatic?: string }) : null;
  const email = (p.data.email ?? null) as Copies | null;
  async function decide(action: "approve" | "discard") {
    if (!delivery) return;
    setDeciding(action);
    try {
      await api("delivery", { action, deliveryId: delivery.id });
    } finally {
      setDeciding("");
      reloadDeliveries();
    }
  }
  const workflow = p.kind === "workflow_message" ? `Workflow “${p.data.workflowName ?? "Automation"}”` : null;
  const who = fromCustomer
    ? customer || "Customer"
    : p.author_type === "ai"
      ? agentName
      : side?.direction === "in"
        ? side.from?.name || side.from?.address || "Email"
        : (workflow ?? p.data.authorName ?? "Teammate");
  return (
    <div className={"pg-bubble-row " + (fromCustomer ? "customer" : "team")}>
      {p.author_type === "ai" ? (
        <ZoeMark size={28} className="pg-avatar pg-bubble-avatar" />
      ) : (
        <span
          className="pg-avatar pg-bubble-avatar"
          data-hue={hueOf(who)}
          aria-hidden="true"
        >
          {initials(who)}
        </span>
      )}
      <article
        data-part-id={p.id}
        className={
          "pg-message " +
          (internal ? "pg-note" : fromCustomer ? "from-customer" : "from-team")
        }
      >
        <header>
          {internal && <LockKeyhole size={13} />}
          <strong>
            {side
              ? side.direction === "in"
                ? `Side conversation · from ${side.from?.name ? `${side.from.name} <${side.from.address}>` : (side.from?.address ?? "email")} · Team only`
                : `Side conversation · ${p.data.authorName ?? "Teammate"} to ${(side.to ?? []).join(", ")} · Team only`
              : p.data.aiHandover
              ? `Handover summary from ${agentName} · Team only`
              : internal
                ? "Internal note · Team only"
              : p.author_type === "contact"
                ? "Customer"
                : workflow
                  ? `${workflow} · to the customer`
                  : (p.data.authorName ??
                  (p.author_type === "ai"
                    ? `${agentName}${specialist ? ` · ${specialist}` : ""} · AI agent`
                    : "Teammate"))}
          </strong>
          {p.channel && p.channel !== "messenger" && (
            <span className="pg-part-channel">via {channelLabel(p.channel)}</span>
          )}
          {edited && !p.data.deleted && (
            <small className="pg-edited">Edited</small>
          )}
        </header>
        {side?.subject && <span className="pg-email-subject">{side.subject}</span>}
        {p.channel === "email" && p.kind === "customer_message" && email?.subject && <span className="pg-email-subject">{email.subject}</span>}
        {/* E4: who an email was to and copied to (the customer's), or who a reply copied in. */}
        {email && (p.kind === "customer_message" ? recipients(email, true) : recipients(email, false)) && (
          <small className="pg-email-recipients">{p.kind === "customer_message" ? recipients(email, true) : recipients(email, false)}</small>
        )}
        {p.data.deleted ? (
          <p>This part was deleted.</p>
        ) : p.data.doc ? (
          <RichText doc={p.data.doc} fallback={p.body} image={agentImage} />
        ) : (
          // An AI handover summary keeps its lines (phase 08 A2a).
          <p className={p.data.aiHandover ? "pg-handover" : undefined}>{p.body}</p>
        )}
        {p.kind === "ai_reply" && <AiReplyDetails p={p} />}
        {side?.automatic && <small className="pg-muted">An automatic reply ({side.automatic.replace("_", " ")}).</small>}
        {side && <SideReply sideId={side.sideId} />}
        {p.channel === "email" && (p.kind === "customer_message" || side?.direction === "in") && (
          <>
            <button type="button" className="pg-email-open" onClick={() => setFull(true)}>
              Show the full email
            </button>
            {full && <EmailView partId={p.id} onClose={() => setFull(false)} />}
          </>
        )}
        {delivery && (
          <small className="pg-delivery" data-status={delivery.status} role={delivery.status === "failed" || delivery.status === "suppressed" ? "alert" : undefined}>
            {DELIVERY_LABELS[delivery.status]}
            {delivery.status === "failed" && delivery.error ? `: ${delivery.error}` : ""}
          </small>
        )}
        {delivery?.status === "held" && (
          // E4: Zoe's draft on email: a teammate sends it as it is, or discards it and replies themselves.
          <span className="pg-wf-inline" aria-label="Zoe's draft">
            <button type="button" className="pg-primary" disabled={!!deciding} onClick={() => void decide("approve")}>
              Send it
            </button>
            <button type="button" className="pg-zoe-secondary" disabled={!!deciding} onClick={() => void decide("discard")}>
              Discard
            </button>
          </span>
        )}
        {p.kind === "workflow_message" && Array.isArray(p.data.options) && p.data.options.length > 0 && (
          <ul className="pg-wf-sent-buttons" aria-label="Reply buttons">
            {(p.data.options as string[]).map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        )}
        {p.kind === "internal_note" && p.data.aiApproval?.id && <ApprovalCard id={p.data.aiApproval.id} />}
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
    </div>
  );
}

type AiAnswer = {
  replyPartId: string | null;
  outcome: string;
  reason: string;
  topScore: number | null;
  threshold: number;
  model: string | null;
  promptVersion: string;
  /** Z2: the language she answered in and the one she read, and the guidance she was given. */
  language: string | null;
  detectedLanguage: string | null;
  guidanceVersion: number | null;
  voice: Voice | null;
  guidance: string[];
  /** Z3a: the specialist who answered, and why she has the conversation. */
  specialist: { name: string; reason: string } | null;
  /** Z3b: content targeted at other customers, left out for this one. */
  targetedOut: { count: number; titles: string[] };
  /** B2: a guard that blocked her reply; how many earlier conversations she remembered; and, for
   * managers, exactly what was sent to the model providers (null for others). */
  guard: string | null;
  remembered: number;
  sent: { kind: string; model: string; sent: string; redacted: boolean; redactions: Record<string, number> }[] | null;
};
const OUTCOMES: Record<string, string> = {
  answered: "Answered from content",
  clarified: "Asked to clarify",
  unknown: "Said it didn't know",
  failed: "The model failed",
  escalated: "Handed to the team",
};
/**
 * Under an AI agent's reply (phase 08): the sources it cited, and on request why it answered as it
 * did (what it found, how relevant, against which threshold, with which model and prompt).
 */
type Approval = {
  id: string;
  connector: string;
  method: string | null;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string;
  version: string;
  result: string | null;
};
const APPROVAL_STATES: Record<Approval["status"], string> = {
  pending: "Waiting for approval",
  approved: "Approved",
  denied: "Denied",
  expired: "Expired: nobody approved it in time",
  cancelled: "Cancelled: the customer left the procedure",
};
/**
 * A write Zoe asked to run (phase 09 D3), on her team-only note: approve or deny it, once, with an
 * optional note. Nothing is sent to the service until someone approves.
 */
function ApprovalCard({ id }: { id: string }) {
  const [a, setA] = useState<Approval | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Approval>("ai-approval?id=" + encodeURIComponent(id))
      .then(setA)
      .catch((e) => setError(e instanceof Error ? e.message : "This approval could not be loaded."));
  }, [id]);
  async function decide(decision: "approve" | "deny") {
    if (!a) return;
    setBusy(true);
    setError("");
    try {
      setA(await api<Approval>("ai-approval", { id, version: a.version, decision, note }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "That could not be saved.");
      api<Approval>("ai-approval?id=" + encodeURIComponent(id)).then(setA).catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="pg-approval" aria-label="Approval" data-status={a?.status}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {a && (
        <>
          <p>
            <strong>{APPROVAL_STATES[a.status]}</strong>
            {a.decidedBy && a.status !== "pending" ? ` by ${a.decidedBy}` : ""}
            {a.note ? `: “${a.note}”` : ""}
            {a.status === "approved" && a.result ? ` · ${a.result === "ok" ? "it worked" : `it failed (${a.result})`}` : ""}
          </p>
          {a.status === "pending" && (
            <>
              <input
                aria-label="Approval note"
                placeholder="Note (optional)"
                maxLength={1000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="pg-approval-actions">
                <button type="button" className="pg-primary" disabled={busy} onClick={() => void decide("approve")}>
                  Approve {a.connector}
                </button>
                <button type="button" disabled={busy} onClick={() => void decide("deny")}>
                  Deny
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function AiReplyDetails({ p }: { p: TimelinePart }) {
  const [answer, setAnswer] = useState<AiAnswer | null | undefined>();
  const [open, setOpen] = useState(false);
  const sources = Array.isArray(p.data.sources)
    ? (p.data.sources as { title: string }[])
    : [];
  async function show() {
    setOpen((x) => !x);
    if (answer !== undefined || !p.conversation_id) return;
    try {
      const r = await api<{ answers: AiAnswer[] }>(
        "ai-answers?conversation=" + encodeURIComponent(p.conversation_id),
      );
      setAnswer(r.answers.find((a) => a.replyPartId === p.id) ?? null);
    } catch {
      setAnswer(null);
    }
  }
  return (
    <div className="pg-ai-details">
      {sources.length > 0 && (
        <p className="pg-ai-sources">
          Sources: {sources.map((s) => s.title || "Untitled").join(" · ")}
        </p>
      )}
      <button
        type="button"
        className="pg-link-button"
        aria-expanded={open}
        onClick={() => void show()}
      >
        <Sparkles size={12} aria-hidden="true" /> Why this reply
      </button>
      {open && (
        <dl className="pg-ai-why">
          {answer === undefined ? (
            <dd>Loading…</dd>
          ) : answer === null ? (
            <dd>No details recorded.</dd>
          ) : (
            <>
              <dt>Outcome</dt>
              <dd>{OUTCOMES[answer.outcome] ?? answer.outcome}</dd>
              <dt>Why</dt>
              <dd>{answer.reason}</dd>
              {answer.topScore !== null && (
                <>
                  <dt>Best match</dt>
                  <dd>
                    {answer.topScore.toFixed(2)} (answers need{" "}
                    {answer.threshold.toFixed(2)})
                  </dd>
                </>
              )}
              {answer.specialist && (
                <>
                  <dt>Specialist</dt>
                  <dd>
                    {answer.specialist.name}: {answer.specialist.reason}
                  </dd>
                </>
              )}
              {answer.guard && (
                <>
                  <dt>Safety</dt>
                  <dd>
                    Her reply was blocked before it reached the customer: it contained{" "}
                    {GUARD_NAMES[answer.guard] ?? answer.guard}.
                  </dd>
                </>
              )}
              {answer.remembered > 0 && (
                <>
                  <dt>Remembered</dt>
                  <dd>
                    {answer.remembered} earlier{" "}
                    {answer.remembered === 1 ? "conversation" : "conversations"} with this customer
                  </dd>
                </>
              )}
              {answer.sent && answer.sent.length > 0 && (
                <>
                  <dt>Sent to the model</dt>
                  <dd>
                    {redactionWords(answer.sent[answer.sent.length - 1].redactions, answer.sent[0].redacted)}
                    <details className="pg-zoe-sent">
                      <summary>Show exactly what was sent</summary>
                      {answer.sent.map((c, i) => (
                        <pre key={i} aria-label={`Sent to ${c.model} (${c.kind})`}>{c.sent}</pre>
                      ))}
                    </details>
                  </dd>
                </>
              )}
              {answer.targetedOut?.count > 0 && (
                <>
                  <dt>Targeting</dt>
                  <dd>
                    Kept {answer.targetedOut.count}{" "}
                    {answer.targetedOut.count === 1 ? "item" : "items"} from her for this customer:{" "}
                    {answer.targetedOut.titles.join(", ")}
                    {answer.targetedOut.count > answer.targetedOut.titles.length ? "…" : ""}
                  </dd>
                </>
              )}
              {answer.language && (
                <>
                  <dt>Language</dt>
                  <dd>
                    {languageName(answer.language)}
                    {answer.detectedLanguage
                      ? `, read in the customer's ${languageName(answer.detectedLanguage)}`
                      : ", from the conversation or their browser"}
                  </dd>
                </>
              )}
              {answer.voice && (
                <>
                  <dt>Voice</dt>
                  <dd>
                    {voiceSummary(answer.voice)}
                    {answer.guidanceVersion ? ` · guidance version ${answer.guidanceVersion}` : ""}
                  </dd>
                </>
              )}
              {answer.guidance.length > 0 && (
                <>
                  <dt>Guidance</dt>
                  <dd>{answer.guidance.join(" · ")}</dd>
                </>
              )}
              <dt>Model</dt>
              <dd>
                {answer.model ?? "None (not asked)"} · prompt{" "}
                {answer.promptVersion}
              </dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

function EventRun({
  parts,
  dir: directory,
}: {
  parts: TimelinePart[];
  dir: Directory;
}) {
  // Zoe's name in her events (Z1).
  const agentName = useAgentName();
  const dir = { ...directory, agentName };
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
  customer,
  aiSpecialist,
}: {
  parts: TimelinePart[];
  dir: Directory;
  /** The customer's name, for their bubbles' initials. */
  customer?: string;
  /** Z3a: the specialist who has the conversation, if one does; her replies are labelled. */
  aiSpecialist?: string | null;
}) {
  // Z3a: who gave each of Zoe's replies, from her answers' records (never the reply's own data,
  // which reaches the customer). Fetched only when a specialist has the conversation.
  const conversationId = parts[0]?.conversation_id;
  const replies = parts.filter((p) => p.kind === "ai_reply").length;
  const [bySpecialist, setBySpecialist] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!aiSpecialist || !conversationId) return;
    let live = true;
    api<{ answers: { replyPartId: string | null; specialist: { name: string } | null }[] }>(
      "ai-answers?conversation=" + encodeURIComponent(conversationId),
    )
      .then((r) => {
        if (live)
          setBySpecialist(
            new Map(
              r.answers
                .filter((a) => a.replyPartId && a.specialist)
                .map((a) => [a.replyPartId!, a.specialist!.name]),
            ),
          );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [aiSpecialist, conversationId, replies]);
  // Phase 12 E1: replies on a channel other than the messenger have a delivery status; fetched
  // when the conversation has such a part, and again as parts arrive.
  const onChannel = parts.some((p) => p.channel && p.channel !== "messenger");
  const [deliveries, setDeliveries] = useState<Map<string, Delivery>>(NO_DELIVERIES);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!onChannel || !conversationId) return;
    let live = true;
    api<{ deliveries: { id: string; partId: string; purpose: string; status: DeliveryStatus; error: string }[] }>("deliveries?conversation=" + encodeURIComponent(conversationId))
      .then(
        (r) =>
          live &&
          // An away email isn't the messenger reply's own delivery (E3): left out here.
          setDeliveries(new Map(r.deliveries.filter((d) => d.purpose !== "away").map((d) => [d.partId, { id: d.id, status: d.status, error: d.error }]))),
      )
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [onChannel, conversationId, parts.length, reload]);
  const superseded = new Set(parts.map((p) => p.supersedes_id).filter(Boolean));
  const visible = parts.filter((p) => !superseded.has(p.id));
  const groups: (TimelinePart | TimelinePart[])[] = [];
  for (const p of visible) {
    const last = groups.at(-1);
    if (MESSAGES.has(p.kind) || isSide(p)) groups.push(p);
    else if (Array.isArray(last)) last.push(p);
    else groups.push([p]);
  }
  return (
    <ReplySpecialists.Provider value={aiSpecialist ? bySpecialist : EMPTY}>
      <Deliveries.Provider value={onChannel ? deliveries : NO_DELIVERIES}>
      <ReloadDeliveries.Provider value={() => setReload((n) => n + 1)}>
      {groups.map((g) =>
        Array.isArray(g) ? (
          <EventRun key={g[0].id} parts={g} dir={dir} />
        ) : (
          <Message
            key={g.id}
            p={g}
            edited={!!g.supersedes_id}
            customer={customer}
          />
        ),
      )}
      </ReloadDeliveries.Provider>
      </Deliveries.Provider>
    </ReplySpecialists.Provider>
  );
}
