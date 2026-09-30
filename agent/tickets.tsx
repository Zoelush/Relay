import { useEffect, useRef, useState } from "react";
import { api, InboxError } from "./api";
import { AttributeField, type Attribute } from "./sidebar";

type StateRef = { id: string; name: string; kind: string };
type Field = Attribute & { requiredToClose: boolean };
export type TicketContext = {
  enabled: boolean;
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

/** The ticket section of the conversation sidebar. */
export function TicketPanel({
  conversationId,
  tickets,
  editable,
  onError,
}: {
  conversationId: string;
  tickets: TicketContext;
  editable: boolean;
  onError: (e: unknown) => void;
}) {
  const [error, setError] = useState<{ text: string; fields: string[] }>({
    text: "",
    fields: [],
  });
  const [changing, setChanging] = useState(false);
  if (!tickets.enabled) return null;
  const t = tickets.ticket;
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
        editable ? (
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
    </section>
  );
}
