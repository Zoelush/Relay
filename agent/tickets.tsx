import { useEffect, useRef, useState } from "react";
import { api, InboxError } from "./api";
import { AttributeField, type Attribute } from "./sidebar";

type StateRef = { id: string; name: string; kind: string };
type Field = Attribute & { requiredToClose: boolean };
type LinkedTicket = {
  id: string;
  number: number;
  title: string;
  category: string;
  type: string;
  state: string;
  resolved: boolean;
};
type Links = {
  internal: boolean;
  tickets: LinkedTicket[];
  conversations: { id: string; title: string; status: string }[];
  total: number;
  broadcasts: { id: string; status: string; body: string }[];
};
export type TicketContext = {
  enabled: boolean;
  links?: Links | null;
  ticket: null | {
    number: number;
    version: string;
    type: { id: string; name: string; icon: string; category: string };
    state: StateRef;
    nextStates: StateRef[];
    fields: Field[];
  };
};
type TicketType = {
  id: string;
  name: string;
  category: string;
  states: StateRef[];
  fields: { attributeId: string; name: string; valueType: string }[];
};
type Preview = {
  from: { id: string; name: string };
  to: { id: string; name: string };
  state: { id: string; name: string };
  kept: { id: string; name: string }[];
  moved: {
    from: { id: string; name: string };
    to: { id: string; name: string };
  }[];
  lost: { id: string; name: string; value: unknown }[];
  token: string;
};

const message = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;
const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v));

/** Converting a conversation: a customer ticket type and a starting state that is not resolved. */
/**
 * The conversation header's "Convert to ticket" starts the form in the details sidebar. The
 * sidebar may only be mounting, so the request waits here until its form picks it up.
 */
let pendingConvert: string | null = null;
export function requestConvert(conversationId: string) {
  pendingConvert = conversationId;
  window.dispatchEvent(
    new CustomEvent("relay:convert", { detail: conversationId }),
  );
}

function Convert({
  conversationId,
  onError,
}: {
  conversationId: string;
  onError: (e: unknown) => void;
}) {
  const [types, setTypes] = useState<TicketType[] | null>(null);
  const [typeId, setTypeId] = useState(""),
    [stateId, setStateId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = async () => {
    try {
      const r = await api<{ types: TicketType[] }>("ticket-types");
      const customer = r.types.filter((t) => t.category === "customer");
      setTypes(customer);
      setTypeId(customer[0]?.id ?? "");
      setStateId("");
    } catch (e) {
      onError(e);
    }
  };
  const form = useRef<HTMLDivElement>(null);
  const requested = useRef(false);
  useEffect(() => {
    const start = () => {
      if (pendingConvert !== conversationId) return;
      pendingConvert = null;
      requested.current = true;
      void load();
    };
    start();
    window.addEventListener("relay:convert", start);
    return () => window.removeEventListener("relay:convert", start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);
  // Once the form appears for a header request, bring it into view and focus its first field.
  useEffect(() => {
    if (!types || !requested.current) return;
    requested.current = false;
    form.current?.scrollIntoView({ block: "nearest" });
    (
      form.current?.querySelector("select") as HTMLSelectElement | null
    )?.focus();
  }, [types]);
  const type = types?.find((t) => t.id === typeId);
  const open = type?.states.filter((s) => s.kind !== "resolved") ?? [];
  const convert = async () => {
    setBusy(true);
    setError("");
    try {
      await api("command", {
        action: "ticket",
        conversationId,
        typeId,
        stateId: stateId || open[0]?.id,
      });
      setTypes(null);
    } catch (e) {
      setError(message(e, "The conversation could not be converted."));
    } finally {
      setBusy(false);
    }
  };
  if (!types)
    return (
      <button type="button" onClick={() => void load()}>
        Convert to ticket
      </button>
    );
  if (!types.length)
    return <p className="pg-empty">No customer ticket types are set up yet.</p>;
  return (
    <div
      ref={form}
      className="pg-ticket-convert"
      role="group"
      aria-label="Convert to ticket"
    >
      <label>
        Ticket type
        <select
          value={typeId}
          onChange={(e) => {
            setTypeId(e.target.value);
            setStateId("");
          }}
        >
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Starting state
        <select
          value={stateId || open[0]?.id || ""}
          onChange={(e) => setStateId(e.target.value)}
        >
          {open.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <div className="pg-ticket-buttons">
        <button type="button" onClick={() => setTypes(null)}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !typeId}
          onClick={() => void convert()}
        >
          Convert
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

/**
 * Changing a ticket's type: the server's preview says which fields are kept, moved or cleared,
 * and the change applies only with that preview's token.
 */
function ChangeType({
  conversationId,
  current,
  onClose,
}: {
  conversationId: string;
  current: { id: string; category: string };
  onClose: () => void;
}) {
  const [types, setTypes] = useState<TicketType[]>([]);
  const [typeId, setTypeId] = useState(""),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    let live = true;
    api<{ types: TicketType[] }>("ticket-types")
      .then((r) => {
        if (!live) return;
        const others = r.types.filter(
          (t) => t.category === current.category && t.id !== current.id,
        );
        setTypes(others);
        setTypeId(others[0]?.id ?? "");
      })
      .catch((e) => live && setError(message(e, "Ticket types unavailable.")));
    return () => {
      live = false;
    };
  }, [current.id, current.category]);
  useEffect(() => {
    if (!typeId) return;
    let live = true;
    api<Preview>(
      "ticket-preview?" +
        new URLSearchParams({
          conversation: conversationId,
          type: typeId,
          mapping: JSON.stringify(mapping),
        }),
    )
      .then((p) => {
        if (!live) return;
        setPreview(p);
        setError("");
      })
      .catch((e) => {
        if (!live) return;
        setPreview(null);
        setError(message(e, "This change cannot be previewed."));
      });
    return () => {
      live = false;
    };
  }, [conversationId, typeId, mapping]);
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const target = types.find((t) => t.id === typeId);
  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await api("command", {
        action: "ticket_type",
        conversationId,
        typeId,
        mapping,
        token: preview.token,
      });
      onClose();
    } catch (e) {
      setError(message(e, "The type could not be changed."));
    } finally {
      setBusy(false);
    }
  };
  const mappedFrom = new Set(preview?.moved.map((m) => m.from.id));
  const takenTo = new Set(preview?.moved.map((m) => m.to.id));
  const keptIds = new Set(preview?.kept.map((k) => k.id));
  return (
    <div className="pg-modal-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Change ticket type"
        className="pg-view-dialog pg-ticket-dialog"
      >
        <h3>Change ticket type</h3>
        {!types.length && !error && (
          <p className="pg-empty">No other ticket types of this category.</p>
        )}
        {types.length > 0 && (
          <label>
            New type
            <select
              ref={first}
              value={typeId}
              onChange={(e) => {
                setTypeId(e.target.value);
                setMapping({});
                setPreview(null);
              }}
            >
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {preview && (
          <>
            <p>
              The ticket will be in <strong>{preview.state.name}</strong>.
            </p>
            {preview.kept.length > 0 && (
              <p>Kept: {preview.kept.map((f) => f.name).join(", ")}</p>
            )}
            {preview.moved.length > 0 && (
              <ul aria-label="Moved fields">
                {preview.moved.map((m) => (
                  <li key={m.from.id}>
                    {m.from.name} → {m.to.name}{" "}
                    <button
                      type="button"
                      onClick={() =>
                        setMapping((old) =>
                          Object.fromEntries(
                            Object.entries(old).filter(
                              ([k]) => k !== m.from.id,
                            ),
                          ),
                        )
                      }
                    >
                      Clear instead
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {preview.lost.length > 0 ? (
              <div role="alert" className="pg-ticket-warning">
                <strong>These values will be cleared:</strong>
                <ul aria-label="Cleared fields">
                  {preview.lost.map((f) => (
                    <li key={f.id}>
                      {f.name}: {show(f.value)}
                      {target && (
                        <select
                          aria-label={`Move ${f.name} to`}
                          value=""
                          onChange={(e) =>
                            e.target.value &&
                            setMapping((m) => ({
                              ...m,
                              [f.id]: e.target.value,
                            }))
                          }
                        >
                          <option value="">Move to…</option>
                          {target.fields
                            .filter(
                              (t) =>
                                !keptIds.has(t.attributeId) &&
                                !takenTo.has(t.attributeId) &&
                                !mappedFrom.has(f.id),
                            )
                            .map((t) => (
                              <option key={t.attributeId} value={t.attributeId}>
                                {t.name}
                              </option>
                            ))}
                        </select>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p>No field values will be lost.</p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="pg-attr-error">
            {error}
          </p>
        )}
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !preview}
            onClick={() => void apply()}
          >
            Change type
          </button>
        </footer>
      </section>
    </div>
  );
}

/** Subscribes the inbox socket to a job, so its pushed progress reaches this page. */
const watchJob = (id: string) =>
  window.dispatchEvent(new CustomEvent("relay:subscribe-job", { detail: id }));

/**
 * Creates a back-office ticket (from `conversationId`, linked to it) or a tracker (standalone,
 * or from `conversationId`, which is then linked).
 */
export function CreateInternal({
  category,
  conversationId,
  onCreated,
  onClose,
}: {
  category: "back_office" | "tracker";
  conversationId?: string;
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const [types, setTypes] = useState<TicketType[]>([]);
  const [typeId, setTypeId] = useState(""),
    [title, setTitle] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const first = useRef<HTMLInputElement>(null);
  const label =
    category === "tracker" ? "tracker ticket" : "back-office ticket";
  useEffect(() => {
    let live = true;
    api<{ types: TicketType[] }>("ticket-types")
      .then((r) => {
        if (!live) return;
        const list = r.types.filter((t) => t.category === category);
        setTypes(list);
        setTypeId(list[0]?.id ?? "");
      })
      .catch((e) => live && setError(message(e, "Ticket types unavailable.")));
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      live = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [category, onClose]);
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ conversationId: string }>("tickets", {
        op: "create",
        typeId,
        title,
        ...(conversationId ? { conversationId } : {}),
      });
      onCreated(r.conversationId);
    } catch (e) {
      setError(message(e, "The ticket could not be created."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pg-modal-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`Create ${label}`}
        className="pg-view-dialog pg-ticket-dialog"
      >
        <h3>Create {label}</h3>
        <label>
          Title
          <input
            ref={first}
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        {types.length ? (
          <label>
            Ticket type
            <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          !error && <p className="pg-empty">No {label} types are set up yet.</p>
        )}
        {conversationId && (
          <p className="pg-empty">
            It will be linked to this conversation. The customer sees nothing of
            it.
          </p>
        )}
        {error && (
          <p role="alert" className="pg-attr-error">
            {error}
          </p>
        )}
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !typeId || !title.trim()}
            onClick={() => void create()}
          >
            Create
          </button>
        </footer>
      </section>
    </div>
  );
}

/** Links this customer conversation to an open tracker. */
function LinkTracker({ conversationId }: { conversationId: string }) {
  const [trackers, setTrackers] = useState<
    { id: string; number: number; title: string }[] | null
  >(null);
  const [error, setError] = useState("");
  const load = async () => {
    try {
      setTrackers(
        (
          await api<{
            trackers: { id: string; number: number; title: string }[];
          }>("tickets")
        ).trackers,
      );
    } catch (e) {
      setError(message(e, "Trackers unavailable."));
    }
  };
  const link = async (trackerId: string) => {
    setError("");
    try {
      await api("command", {
        action: "ticket_link",
        conversationId,
        trackerId,
      });
      setTrackers(null);
    } catch (e) {
      setError(message(e, "The conversation could not be linked."));
    }
  };
  return (
    <>
      {trackers === null ? (
        <button type="button" onClick={() => void load()}>
          Link to tracker
        </button>
      ) : trackers.length ? (
        <label className="pg-attr">
          Tracker
          <select
            value=""
            onChange={(e) => e.target.value && void link(e.target.value)}
          >
            <option value="">Choose a tracker…</option>
            {trackers.map((t) => (
              <option key={t.id} value={t.id}>
                #{t.number} {t.title}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="pg-empty">No open trackers.</p>
      )}
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
    </>
  );
}

type BroadcastStatus = {
  status: string;
  closeAfter: boolean;
  counts: Record<string, number>;
  problems: { id: string; title: string; state: string; error: string }[];
};
/**
 * A tracker broadcast: the server counts who will receive it (open and snoozed linked
 * conversations; closed ones are skipped), the teammate confirms, and a job sends it.
 */
function Broadcast({
  trackerId,
  onClose,
}: {
  trackerId: string;
  onClose: () => void;
}) {
  const [text, setText] = useState(""),
    [closeAfter, setCloseAfter] = useState(false),
    [prepared, setPrepared] = useState<{
      broadcastId: string;
      sending: number;
      skipped: number;
    } | null>(null),
    [job, setJob] = useState<{ broadcastId: string; jobId: string } | null>(
      null,
    ),
    [status, setStatus] = useState<BroadcastStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const first = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Progress arrives as pushed job frames; each one re-reads the broadcast.
  useEffect(() => {
    if (!job) return;
    let live = true;
    const read = () =>
      api<BroadcastStatus>(
        "ticket-broadcast?" + new URLSearchParams({ id: job.broadcastId }),
      )
        .then((s) => live && setStatus(s))
        .catch((e) => live && setError(message(e, "Progress unavailable.")));
    const listener = (e: Event) => {
      if ((e as CustomEvent<{ id: string }>).detail?.id === job.jobId)
        void read();
    };
    window.addEventListener("relay:job", listener);
    void read();
    return () => {
      live = false;
      window.removeEventListener("relay:job", listener);
    };
  }, [job]);
  const prepare = async () => {
    setBusy(true);
    setError("");
    try {
      setPrepared(
        await api("tickets", {
          op: "broadcast-prepare",
          trackerId,
          text,
          closeAfter,
        }),
      );
    } catch (e) {
      setError(message(e, "The update could not be prepared."));
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (!prepared) return;
    setBusy(true);
    try {
      const r = await api<{ jobId: string }>("tickets", {
        op: "broadcast-commit",
        broadcastId: prepared.broadcastId,
      });
      watchJob(r.jobId);
      setJob({ broadcastId: prepared.broadcastId, jobId: r.jobId });
    } catch (e) {
      setError(message(e, "The update could not be sent."));
    } finally {
      setBusy(false);
    }
  };
  const plural = (n: number) =>
    `${n.toLocaleString()} conversation${n === 1 ? "" : "s"}`;
  const n = (k: string) => status?.counts[k] ?? 0;
  return (
    <div className="pg-modal-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Broadcast update"
        className="pg-view-dialog pg-ticket-dialog"
      >
        <h3>Broadcast update</h3>
        {!prepared ? (
          <>
            <label>
              Message to every linked customer
              <textarea
                ref={first}
                rows={5}
                maxLength={5000}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <label className="pg-inline-check">
              <input
                type="checkbox"
                checked={closeAfter}
                onChange={(e) => setCloseAfter(e.target.checked)}
              />
              Close linked conversations after sending
            </label>
          </>
        ) : !job ? (
          <p>
            Send this as a reply to <strong>{plural(prepared.sending)}</strong>?
            {prepared.skipped > 0 &&
              ` ${plural(prepared.skipped)} already closed will be skipped.`}
            {closeAfter && " They will then be closed."}
          </p>
        ) : (
          <div role="status" aria-label="Broadcast progress">
            {!status || status.status !== "done" ? (
              <p>
                Sending… {n("sent") + n("failed")} of {prepared.sending} done
              </p>
            ) : (
              <p>
                Sent to {plural(n("sent"))}.
                {status.closeAfter && ` Closed ${plural(n("closed"))}.`}
                {n("failed") > 0 &&
                  ` ${plural(n("failed"))} could not be sent.`}
                {n("skipped") > 0 &&
                  ` ${plural(n("skipped"))} skipped (closed).`}
              </p>
            )}
            {status && status.problems.length > 0 && (
              <ul aria-label="Needs attention">
                {status.problems.map((p) => (
                  <li key={p.id}>
                    {p.title || "Conversation"}: {p.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="pg-attr-error">
            {error}
          </p>
        )}
        <footer>
          <button type="button" onClick={onClose}>
            {job ? "Close" : "Cancel"}
          </button>
          {!prepared && (
            <button
              type="button"
              disabled={busy || !text.trim()}
              onClick={() => void prepare()}
            >
              Review
            </button>
          )}
          {prepared && !job && (
            <button type="button" disabled={busy} onClick={() => void send()}>
              Send to {plural(prepared.sending)}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

/** Linked tickets (on a customer conversation) or linked conversations (on a ticket). */
function LinkList({
  links,
  trackerId,
  editable,
  onOpen,
}: {
  links: Links;
  trackerId: string | null;
  editable: boolean;
  onOpen: (id: string) => void;
}) {
  const unlink = (conversationId: string) =>
    void api("command", {
      action: "ticket_unlink",
      conversationId,
      trackerId,
    }).catch(() => {});
  return (
    <>
      {links.tickets.length > 0 && (
        <ul className="pg-ctx-recent" aria-label="Linked tickets">
          {links.tickets.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => onOpen(t.id)}>
                <span>
                  #{t.number} {t.title}
                </span>
                <small>
                  {t.category === "tracker" ? "Tracker" : "Back-office"} ·{" "}
                  {t.type} · {t.state}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {links.internal && (
        <div aria-label="Linked conversations" role="region">
          <h4>
            Linked conversations <small>({links.total.toLocaleString()})</small>
          </h4>
          {links.conversations.length ? (
            <ul className="pg-ctx-recent">
              {links.conversations.map((c) => (
                <li key={c.id} className="pg-link-row">
                  <button type="button" onClick={() => onOpen(c.id)}>
                    <span>{c.title || "Conversation"}</span>
                    <small>{c.status}</small>
                  </button>
                  {trackerId && editable && (
                    <button
                      type="button"
                      aria-label={`Unlink ${c.title || "conversation"}`}
                      onClick={() => unlink(c.id)}
                    >
                      Unlink
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="pg-empty">No linked conversations yet.</p>
          )}
        </div>
      )}
    </>
  );
}

/** The ticket section of the conversation sidebar. */
export function TicketPanel({
  conversationId,
  tickets,
  editable,
  onError,
  onOpen,
}: {
  conversationId: string;
  tickets: TicketContext;
  editable: boolean;
  onError: (e: unknown) => void;
  onOpen: (id: string) => void;
}) {
  const [error, setError] = useState<{ text: string; fields: string[] }>({
    text: "",
    fields: [],
  });
  const [changing, setChanging] = useState(false);
  const [dialog, setDialog] = useState<"back_office" | "broadcast" | null>(
    null,
  );
  if (!tickets.enabled) return null;
  const t = tickets.ticket;
  const links = tickets.links;
  const internal = !!links?.internal;
  const tracker = t?.type.category === "tracker";
  const move = async (stateId: string) => {
    setError({ text: "", fields: [] });
    try {
      await api("command", { action: "ticket_state", conversationId, stateId });
    } catch (e) {
      const details = (e instanceof InboxError
        ? (e.data as { error?: { details?: { fields?: { id: string }[] } } })
            ?.error?.details
        : undefined) ?? { fields: [] };
      setError({
        text: message(e, "The ticket could not be moved."),
        fields: (details.fields ?? []).map((f) => f.id),
      });
    }
  };
  return (
    <section aria-labelledby="ctx-ticket" className="pg-ticket">
      <h3 id="ctx-ticket">Ticket</h3>
      {!t ? (
        editable && !internal ? (
          <Convert conversationId={conversationId} onError={onError} />
        ) : (
          <p className="pg-empty">Not a ticket.</p>
        )
      ) : (
        <>
          <p className="pg-ticket-head">
            <strong>#{t.number}</strong> · {t.type.name}
            <span
              className={`pg-ticket-state pg-state-${t.state.kind}`}
              data-testid="ticket-state"
            >
              {t.state.name}
            </span>
          </p>
          {editable && t.nextStates.length > 0 && (
            <label className="pg-attr">
              Move to
              <select
                value=""
                onChange={(e) => e.target.value && void move(e.target.value)}
              >
                <option value="">Choose a state…</option>
                {t.nextStates.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {error.text && (
            <p role="alert" className="pg-attr-error">
              {error.text}
            </p>
          )}
          {t.fields.map((f) => (
            <AttributeField
              key={conversationId + ":" + f.id + ":" + JSON.stringify(f.value)}
              attribute={f}
              conversationId={conversationId}
              editable={editable}
              required={f.requiredToClose}
              missing={error.fields.includes(f.id)}
            />
          ))}
          {editable && (
            <button type="button" onClick={() => setChanging(true)}>
              Change type…
            </button>
          )}
          {changing && (
            <ChangeType
              conversationId={conversationId}
              current={t.type}
              onClose={() => setChanging(false)}
            />
          )}
        </>
      )}
      {links && (
        <LinkList
          links={links}
          trackerId={tracker ? conversationId : null}
          editable={editable}
          onOpen={onOpen}
        />
      )}
      {editable && !internal && (
        <div className="pg-ticket-buttons pg-ticket-links">
          <button type="button" onClick={() => setDialog("back_office")}>
            Create back-office ticket
          </button>
          <LinkTracker conversationId={conversationId} />
        </div>
      )}
      {editable && tracker && (
        <button type="button" onClick={() => setDialog("broadcast")}>
          Broadcast update…
        </button>
      )}
      {dialog === "back_office" && (
        <CreateInternal
          category="back_office"
          conversationId={conversationId}
          onCreated={() => setDialog(null)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "broadcast" && (
        <Broadcast trackerId={conversationId} onClose={() => setDialog(null)} />
      )}
    </section>
  );
}
