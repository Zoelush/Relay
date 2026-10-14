import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { api } from "./api";
import { channelLabel } from "../lib/channels";

/**
 * Where a reply goes (phase 12, step E3; docs/OMNICHANNEL_STEP3.md): on a conversation whose
 * current channel isn't the messenger, the composer says so ("Emailed to robin@example.com ·
 * Re: Damaged order") instead of "Visible to the customer". Read again as parts arrive, since
 * the customer's next message can move the conversation.
 */
type Target = { channel: string; address: string | null; subject?: string; copies?: boolean; cc?: string } | null;
export function useReplyTarget(conversationId: string, refresh: number) {
  const [target, setTarget] = useState<{ id: string; target: Target }>({ id: "", target: null });
  useEffect(() => {
    if (!conversationId) return;
    let live = true;
    api<{ target: Target }>("reply-target?conversation=" + encodeURIComponent(conversationId))
      .then((r) => live && setTarget({ id: conversationId, target: r.target }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [conversationId, refresh]);
  return target.id === conversationId ? target.target : null;
}
export function ReplyTarget({ target }: { target: NonNullable<Target> }) {
  const how = target.channel === "email" ? "Emailed" : `Sent by ${channelLabel(target.channel)}`;
  return (
    <span className="pg-reply-target" aria-label="Where this reply goes">
      {target.channel === "email" && <Mail size={13} aria-hidden="true" />}
      {how}
      {target.address ? ` to ${target.address}` : ""}
      {target.subject ? ` · ${target.subject}` : ""}
    </span>
  );
}

/**
 * E4: Cc and Bcc on a reply, where the channel takes copies (email). Cc starts as who the
 * customer's last email copied in (reply all); the composer reads the values when it sends.
 */
export type Copies = { cc: string; bcc: string };
export function EmailCopies({ initialCc, onChange }: { initialCc: string; onChange: (c: Copies) => void }) {
  const [open, setOpen] = useState(!!initialCc);
  const [cc, setCc] = useState(initialCc);
  const [bcc, setBcc] = useState("");
  // What a send reads starts as the suggestion, for this conversation.
  useEffect(() => {
    onChange({ cc: initialCc, bcc: "" });
  }, [initialCc, onChange]);
  const change = (next: Copies) => {
    onChange(next);
    setCc(next.cc);
    setBcc(next.bcc);
  };
  if (!open)
    return (
      <button type="button" className="pg-email-open" onClick={() => setOpen(true)}>
        Cc / Bcc
      </button>
    );
  return (
    <div className="pg-email-copies">
      <label>
        Cc <input value={cc} placeholder="name@example.com, …" onChange={(e) => change({ cc: e.target.value, bcc })} />
      </label>
      <label>
        Bcc <input value={bcc} placeholder="name@example.com, …" onChange={(e) => change({ cc, bcc: e.target.value })} />
      </label>
    </div>
  );
}
export const splitCopies = (v: string) => v.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
