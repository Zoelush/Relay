import { useEffect, useState } from "react";
import { api } from "./api";
import type { AppCard } from "../lib/app-slots";
import { TicketPanel, type TicketContext } from "./tickets";
import { SlaSection, type SlaContext } from "./sla";
import { initials } from "./card";
import { hueOf } from "./colour";

export type Attribute = {
  id: string;
  name: string;
  valueType: "string" | "integer" | "float" | "boolean" | "date" | "options";
  options: string[];
  value: unknown;
};
export type Context = {
  personalData: boolean;
  customer: null | {
    id: string;
    role: string;
    firstSeenAt: string;
    lastSeenAt: string;
    signedUpAt: string | null;
    timezone: string | null;
    unsubscribed: boolean;
    name?: string;
    externalId?: string | null;
    emails?: { value: string; verified: boolean }[];
    phones?: { value: string; verified: boolean }[];
  };
  participants: { role: string; name?: string }[];
  recent: { id: string; title: string; status: string; updatedAt: string }[];
  attributes: Attribute[];
  canEditAttributes: boolean;
  tickets: TicketContext;
  sla?: SlaContext;
  apps: AppCard[];
};

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const ROLE = { visitor: "Visitor", lead: "Lead", user: "User" } as Record<
  string,
  string
>;

/** The customer's local time, refreshed every minute. */
function LocalTime({ timezone }: { timezone: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  let text: string;
  try {
    text = now.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
    });
  } catch {
    return null;
  }
  return (
    <dd data-testid="customer-local-time">
      {text} local · {timezone}
    </dd>
  );
}

/**
 * One conversation attribute, edited inline. Changes apply at once and are saved through the
 * attribute command; a rejected value is put back, with the server's reason shown.
 */
export function AttributeField({
  attribute,
  conversationId,
  editable,
  required,
  missing,
}: {
  attribute: Attribute;
  conversationId: string;
  editable: boolean;
  /** A ticket field that must be filled before the ticket is closed. */
  required?: boolean;
  /** Highlighted after a closure was refused for want of this field. */
  missing?: boolean;
}) {
  const [value, setValue] = useState<unknown>(attribute.value);
  const [draft, setDraft] = useState(
    attribute.value == null ? "" : String(attribute.value),
  );
  const [error, setError] = useState("");
  const save = async (next: unknown) => {
    const previous = value;
    setValue(next);
    setError("");
    try {
      await api("command", {
        action: "attribute_set",
        conversationId,
        attributeId: attribute.id,
        value: next,
      });
    } catch (e) {
      setValue(previous);
      setDraft(previous == null ? "" : String(previous));
      setError(
        e instanceof Error ? e.message : "The value could not be saved.",
      );
    }
  };
  const commitText = () => {
    const text = draft.trim();
    const next =
      text === ""
        ? null
        : attribute.valueType === "integer" || attribute.valueType === "float"
          ? Number(text)
          : text;
    if (next !== value && !(next === null && value == null)) void save(next);
  };
  const id = "attr-" + attribute.id;
  let field: React.ReactNode;
  if (attribute.valueType === "boolean")
    field = (
      <input
        id={id}
        type="checkbox"
        checked={value === true}
        disabled={!editable}
        onChange={(e) => void save(e.target.checked)}
      />
    );
  else if (attribute.valueType === "options")
    field = (
      <span
        className="pg-attr-options"
        role="group"
        aria-labelledby={id + "-label"}
      >
        {attribute.options.map((option) => {
          const chosen = Array.isArray(value) && value.includes(option);
          return (
            <label key={option}>
              <input
                type="checkbox"
                checked={chosen}
                disabled={!editable}
                onChange={() => {
                  const list = Array.isArray(value) ? (value as string[]) : [];
                  void save(
                    chosen
                      ? list.filter((x) => x !== option)
                      : [...list, option],
                  );
                }}
              />
              {option}
            </label>
          );
        })}
      </span>
    );
  else
    field = (
      <input
        id={id}
        type={attribute.valueType === "date" ? "date" : "text"}
        inputMode={
          attribute.valueType === "integer"
            ? "numeric"
            : attribute.valueType === "float"
              ? "decimal"
              : undefined
        }
        value={draft}
        disabled={!editable}
        placeholder="Empty"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitText();
          }
        }}
      />
    );
  return (
    <div className={missing ? "pg-attr pg-attr-missing" : "pg-attr"}>
      <label id={id + "-label"} htmlFor={id}>
        {attribute.name}
        {required && (
          <small className="pg-attr-required"> · Required to close</small>
        )}
      </label>
      {field}
      {error && (
        <span className="pg-attr-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** The conversation's context: customer, attributes, recent conversations, participants, apps. */
export function ContextSidebar({
  conversationId,
  refresh,
  onOpen,
  onError,
}: {
  conversationId: string;
  /** Changes when the conversation's attributes change elsewhere, to reload. */
  refresh: number;
  onOpen: (id: string) => void;
  onError: (e: unknown) => void;
}) {
  const [data, setData] = useState<{
    id: string;
    context: Context;
    receivedAt: number;
  } | null>(null);
  useEffect(() => {
    let live = true;
    api<Context>(
      "context?" + new URLSearchParams({ conversation: conversationId }),
    )
      .then((context) => {
        if (live)
          setData({ id: conversationId, context, receivedAt: Date.now() });
      })
      .catch((e) => live && onError(e));
    return () => {
      live = false;
    };
  }, [conversationId, refresh, onError]);
  const c = data?.id === conversationId ? data.context : null;
  if (!c)
    return (
      <aside
        className="pg-context"
        aria-label="Conversation details"
        aria-busy="true"
      >
        <p className="pg-empty">Loading details…</p>
      </aside>
    );
  const customer = c.customer;
  return (
    <aside className="pg-context" aria-label="Conversation details">
      <section aria-labelledby="ctx-customer">
        <h3 id="ctx-customer">Customer</h3>
        {!customer ? (
          <p className="pg-empty">No customer record.</p>
        ) : (
          <>
            <div className="pg-ctx-card">
              <span
                className="pg-avatar"
                data-hue={hueOf((c.personalData && customer.name) || "?")}
                aria-hidden="true"
              >
                {initials((c.personalData && customer.name) || "?")}
              </span>
              <strong>
                {c.personalData ? customer.name || "Unknown" : "Customer"}
              </strong>
              <span className="pg-ctx-role">
                <span className="pg-visually-hidden">Type: </span>
                {ROLE[customer.role] ?? customer.role}
              </span>
            </div>
            <dl>
              {c.personalData ? (
                <>
                  {customer.emails?.map((e) => (
                    <div key={e.value} className="pg-ctx-row">
                      <dt>Email</dt>
                      <dd>
                        {e.value}
                        {e.verified ? " · verified" : ""}
                      </dd>
                    </div>
                  ))}
                  {customer.phones?.map((p) => (
                    <div key={p.value} className="pg-ctx-row">
                      <dt>Phone</dt>
                      <dd>{p.value}</dd>
                    </div>
                  ))}
                  {customer.externalId && (
                    <>
                      <dt>External ID</dt>
                      <dd>{customer.externalId}</dd>
                    </>
                  )}
                </>
              ) : (
                <p className="pg-empty">
                  Your role cannot see personal details.
                </p>
              )}
              {customer.timezone && (
                <>
                  <dt>Local time</dt>
                  <LocalTime timezone={customer.timezone} />
                </>
              )}
              <dt>First seen</dt>
              <dd>{when(customer.firstSeenAt)}</dd>
              <dt>Last seen</dt>
              <dd>{when(customer.lastSeenAt)}</dd>
              {customer.signedUpAt && (
                <>
                  <dt>Signed up</dt>
                  <dd>{when(customer.signedUpAt)}</dd>
                </>
              )}
              {customer.unsubscribed && <dd>Unsubscribed from messages</dd>}
            </dl>
          </>
        )}
      </section>
      {c.sla && data && <SlaSection sla={c.sla} receivedAt={data.receivedAt} />}
      <TicketPanel
        conversationId={conversationId}
        tickets={c.tickets ?? { enabled: false, ticket: null }}
        editable={c.canEditAttributes}
        onError={onError}
        onOpen={onOpen}
      />
      {c.attributes.length > 0 && (
        <section aria-labelledby="ctx-attributes">
          <h3 id="ctx-attributes">Conversation attributes</h3>
          {c.attributes.map((a) => (
            <AttributeField
              key={conversationId + ":" + a.id + ":" + JSON.stringify(a.value)}
              attribute={a}
              conversationId={conversationId}
              editable={c.canEditAttributes}
            />
          ))}
        </section>
      )}
      <section aria-labelledby="ctx-recent">
        <h3 id="ctx-recent">Recent conversations</h3>
        {c.recent.length ? (
          <ul className="pg-ctx-recent">
            {c.recent.map((r) => (
              <li key={r.id}>
                <button onClick={() => onOpen(r.id)}>
                  <span>{r.title || "Conversation"}</span>
                  <small>
                    {r.status} · {when(r.updatedAt)}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pg-empty">No other conversations.</p>
        )}
      </section>
      {c.participants.length > 0 && (
        <section aria-labelledby="ctx-participants">
          <h3 id="ctx-participants">Participants</h3>
          <ul>
            {c.participants.map((p, i) => (
              <li key={i}>
                {p.name || "Participant"} · {ROLE[p.role] ?? p.role}
              </li>
            ))}
          </ul>
        </section>
      )}
      {/* TODO(phase 15): installed apps' cards, hosted through lib/app-slots.ts. */}
      {c.apps.length > 0 && (
        <section aria-labelledby="ctx-apps">
          <h3 id="ctx-apps">Apps</h3>
          {c.apps.map((card) => (
            <article key={card.appId} className="pg-app-card">
              <h4>{card.title}</h4>
              {card.state.status === "loading" ? (
                <p aria-busy="true">Loading…</p>
              ) : card.state.status === "error" ? (
                <p role="alert">{card.state.message}</p>
              ) : (
                card.state.blocks.map((b, i) =>
                  b.type === "heading" ? (
                    <h5 key={i}>{b.text}</h5>
                  ) : (
                    <p key={i}>{b.text}</p>
                  ),
                )
              )}
            </article>
          ))}
        </section>
      )}
    </aside>
  );
}
