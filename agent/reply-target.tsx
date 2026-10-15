import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { api } from "./api";
import { channelLabel } from "../lib/channels";
import { segmentsOf } from "../lib/sms";

/**
 * Where a reply goes (phase 12, step E3; docs/OMNICHANNEL_STEP3.md): on a conversation whose
 * current channel isn't the messenger, the composer says so ("Emailed to robin@example.com ·
 * Re: Damaged order") instead of "Visible to the customer". Read again as parts arrive, since
 * the customer's next message can move the conversation.
 */
type WaTemplate = { id: string; name: string; language: string; body: string; params: number };
type Target = {
  channel: string;
  address: string | null;
  subject?: string;
  copies?: boolean;
  cc?: string;
  /** E5: a session window (WhatsApp's 24 hours), and the templates that may go once it's closed. */
  window?: { open: boolean; closesAt: string | null };
  /** E7: what the channel says about its closed window (Messenger's and Instagram's differ from WhatsApp's). */
  windowNote?: string | null;
  templates?: WaTemplate[];
  /** E6: the number a text goes from, its segment limit, and what a segment costs to the customer's country. */
  from?: string | null;
  maxSegments?: number;
  price?: { perSegment: number; currency: string; estimated: boolean } | null;
} | null;
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
  const closes = target.window?.closesAt ? new Date(target.window.closesAt) : null;
  return (
    <>
      <span className="pg-reply-target" aria-label="Where this reply goes">
        {target.channel === "email" && <Mail size={13} aria-hidden="true" />}
        {how}
        {target.from ? ` from ${target.from}` : ""}
        {target.address ? ` to ${target.address}` : ""}
        {target.subject ? ` · ${target.subject}` : ""}
        {target.window?.open && closes ? ` · window open until ${closes.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
      </span>
      {/* E5: once the window has closed, only a template may go; E7: the channel's own note. */}
      {target.window && !target.window.open && (
        <strong className="pg-window-closed" role="status">
          {target.windowNote ?? "The 24-hour window has closed: send an approved template."}
        </strong>
      )}
    </>
  );
}

/** E5: a template as the reply: chosen, its values filled in, previewed, sent. */
export function TemplatePicker({ conversationId, templates, onSent }: { conversationId: string; templates: WaTemplate[]; onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState(templates[0]?.id ?? "");
  const [params, setParams] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const t = templates.find((x) => x.id === id) ?? templates[0];
  if (!t) return null;
  if (!open)
    return (
      <button type="button" className="pg-email-open" onClick={() => setOpen(true)}>
        Send a template
      </button>
    );
  const preview = t.body.replace(/\{\{(\d+)\}\}/g, (_, i) => params[Number(i) - 1] || `{{${i}}}`);
  return (
    <div className="pg-template-picker" role="group" aria-label="Send a template">
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <label>
        Template{" "}
        <select
          value={t.id}
          onChange={(e) => {
            setId(e.target.value);
            setParams([]);
          }}
        >
          {templates.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} ({x.language})
            </option>
          ))}
        </select>
      </label>
      {[...Array(t.params)].map((_, i) => (
        <label key={t.id + i}>
          {`{{${i + 1}}}`}{" "}
          <input
            value={params[i] ?? ""}
            onChange={(e) => {
              const next = [...params];
              next[i] = e.target.value;
              setParams(next);
            }}
          />
        </label>
      ))}
      <p className="pg-template-preview">{preview}</p>
      <span className="pg-wf-inline">
        <button
          type="button"
          className="pg-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await api("command", { action: "reply", conversationId, template: { id: t.id, params: [...Array(t.params)].map((_, i) => params[i] ?? "") } });
              setOpen(false);
              setParams([]);
              onSent();
            } catch (e) {
              setError(e instanceof Error ? e.message : "The template couldn't be sent.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Send template
        </button>
        <button type="button" className="pg-zoe-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </span>
    </div>
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

/**
 * E6: a text's segments as it's written (GSM-7 or Unicode), and roughly what it costs. Over the
 * limit, it says so: the server refuses it too.
 */
export function SmsMeter({ text, max, price }: { text: string; max: number; price?: { perSegment: number; currency: string; estimated: boolean } | null }) {
  const s = segmentsOf(text);
  const cost = price && s.segments ? s.segments * price.perSegment : null;
  return (
    <span className="pg-sms-meter" data-over={s.segments > max ? "true" : undefined} aria-label="Text length">
      {s.segments === 1 ? "1 segment" : `${s.segments} segments`} ({s.units}/{s.perSegment * Math.max(1, s.segments)}
      {s.encoding === "UCS-2" ? ", Unicode" : ""})
      {cost !== null ? ` · ${price!.estimated ? "about " : ""}${cost.toFixed(cost < 0.1 ? 4 : 2)} ${price!.currency}` : ""}
      {s.segments > max ? ` · too long: ${max} at most` : ""}
    </span>
  );
}
