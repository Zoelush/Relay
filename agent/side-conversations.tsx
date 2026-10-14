import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MailPlus, X } from "lucide-react";
import { api } from "./api";

/**
 * Side conversations (phase 12, step E4; docs/OMNICHANNEL_STEP4.md): email threads with someone
 * other than the customer, attached to a conversation. Their messages show in its timeline for
 * the team only; a teammate starts one from the composer, and replies under any of its messages.
 */
type Side = { id: string; subject: string; participants: string[]; messages: number };

/** "Side conversation" in the composer: shown when email is on (the list answers), with a dialog to start one. */
export function SideConversationButton({ conversationId, refresh }: { conversationId: string; refresh: number }) {
  const [sides, setSides] = useState<Side[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!conversationId) return;
    let live = true;
    api<{ sideConversations: Side[] }>("side-conversations?conversation=" + encodeURIComponent(conversationId))
      .then((r) => live && setSides(r.sideConversations))
      .catch(() => live && setSides(null));
    return () => {
      live = false;
    };
  }, [conversationId, refresh]);
  if (!sides) return null;
  return (
    <>
      <button type="button" className="pg-macros-button pg-side-button" onClick={() => setOpen(true)} title="Email someone else about this conversation">
        <MailPlus size={14} aria-hidden="true" /> Side conversation{sides.length ? ` (${sides.length})` : ""}
      </button>
      {/* The composer is a form, and forms can't nest: the dialog's own form goes to the app's root
          (inside its fonts and theme, outside the composer). */}
      {open && createPortal(<StartSide conversationId={conversationId} onClose={() => setOpen(false)} />, document.querySelector(".pg-inbox") ?? document.body)}
    </>
  );
}

function StartSide({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true);
    setError("");
    try {
      await api("side-conversation", { action: "start", conversationId, to: to.split(/[,;\s]+/).filter(Boolean), subject, text });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "It couldn't be sent.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="pg-modal-backdrop" onKeyDown={(e) => e.key === "Escape" && onClose()} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label="New side conversation"
        className="pg-dialog pg-side-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <header className="pg-email-head">
          <h2>New side conversation</h2>
          <button type="button" className="pg-wf-icon" aria-label="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <p className="pg-muted">An email to someone else about this conversation. Their answers show here, for your team only: the customer never sees it.</p>
        {error && (
          <p role="alert" className="pg-attr-error">
            {error}
          </p>
        )}
        <label>
          To
          <input autoFocus value={to} placeholder="supplier@example.com" onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Subject
          <input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <label>
          Message
          <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <div className="pg-wf-inline">
          <button type="submit" className="pg-primary" disabled={busy || !to.trim() || !subject.trim() || !text.trim()}>
            Send
          </button>
          <button type="button" className="pg-zoe-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

/** Under a side conversation's message: reply in it. */
export function SideReply({ sideId }: { sideId: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button type="button" className="pg-email-open" onClick={() => setOpen(true)}>
        Reply in the side conversation
      </button>
    );
  return (
    <form
      className="pg-side-reply"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await api("side-conversation", { action: "reply", sideId, text });
          setText("");
          setOpen(false);
        } catch (err) {
          setError(err instanceof Error ? err.message : "It couldn't be sent.");
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <textarea aria-label="Side conversation reply" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      <span className="pg-wf-inline">
        <button type="submit" className="pg-primary" disabled={busy || !text.trim()}>
          Send to the side conversation
        </button>
        <button type="button" className="pg-zoe-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </span>
    </form>
  );
}
