import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import {
  Card,
  Field,
  Frame,
  message,
  type MenuState,
  type Page,
} from "./settings-ui";

/**
 * Settings › Helpdesk data (S2b; docs/SETTINGS_STEP3.md): tags, conversation attributes and
 * ticket types. Tags and attributes are archived, never deleted, because conversations and their
 * history point at them; an attribute's type is fixed once created, and a list's options can be
 * added but not renamed or removed. Ticket types edit through the tickets API, which checks the
 * whole definition (states, moves between them, fields) before anything is stored.
 */
type Tag = {
  id: string;
  name: string;
  archived: boolean;
  conversations: number;
};
type ValueType =
  "string" | "integer" | "float" | "boolean" | "date" | "options";
type Attribute = {
  id: string;
  name: string;
  valueType: ValueType;
  options: string[];
  archived: boolean;
  ticketTypes: string[];
};
const TYPES: [ValueType, string, string][] = [
  ["string", "Text", "Any text, such as an order number."],
  ["integer", "Number", "A whole number, such as a quantity."],
  ["float", "Decimal", "A number with decimals, such as an amount."],
  ["boolean", "Yes or no", "A checkbox."],
  ["date", "Date", "A calendar date."],
  ["options", "List", "One or more options from a list you set."],
];
const typeName = (t: ValueType) => TYPES.find(([v]) => v === t)?.[1] ?? t;
const plural = (n: number, one: string, many = one + "s") =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The list, notice and error state every page here shares. */
function useList<T>(path: string, key: string, onChanged?: () => void) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api<Record<string, T[]>>(path)
        .then((r) => setItems(r[key]))
        .catch((e) => setError(message(e, "This page could not be loaded."))),
    [path, key],
  );
  useEffect(() => {
    void load();
  }, [load]);
  /** Sends one change, then says what happened and reloads. */
  async function run(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(path, body);
      setNotice(done);
      onChanged?.();
      return true;
    } catch (e) {
      setError(message(e, "That change could not be saved."));
      return false;
    } finally {
      setBusy(false);
      void load();
    }
  }
  return { items, error, notice, busy, run, load, setNotice };
}
function Messages({ error, notice }: { error: string; notice: string }) {
  return (
    <>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="pg-settings-notice">
          {notice}
        </p>
      )}
    </>
  );
}

export function TagsPage({
  menu,
  page,
  onChanged,
}: {
  menu: MenuState;
  page: Page;
  /** A tag changed: the app refreshes its directory, so pickers and history follow. */
  onChanged?: () => void;
}) {
  const { items, error, notice, busy, run } = useList<Tag>(
    "tags",
    "tags",
    onChanged,
  );
  const [name, setName] = useState("");
  const [find, setFind] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const shown = (items ?? []).filter((t) =>
    t.name.toLowerCase().includes(find.trim().toLowerCase()),
  );
  const active = shown.filter((t) => !t.archived);
  const archived = shown.filter((t) => t.archived);
  return (
    <Frame menu={menu} page={page}>
      <Messages error={error} notice={notice} />
      <Card
        title="New tag"
        description="Tags group conversations for views, reports and macros. Names are unique, whatever their case."
      >
        <form
          className="pg-settings-row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run({ name }, `Added ${name.trim()}.`)) setName("");
          }}
        >
          <Field label="Tag name">
            {(id) => (
              <input
                id={id}
                value={name}
                maxLength={60}
                required
                placeholder="Billing question"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <button type="submit" className="pg-primary" disabled={busy}>
            Add tag
          </button>
        </form>
      </Card>
      <Card
        title="Tags"
        description="Renaming a tag renames it everywhere, history included. Archiving keeps it on the conversations that have it, but it can't be added again."
      >
        {(items?.length ?? 0) > 10 && (
          <input
            aria-label="Find a tag"
            placeholder="Find a tag"
            value={find}
            onChange={(e) => setFind(e.target.value)}
          />
        )}
        {items && !active.length && (
          <p className="pg-muted">{find ? "No tags match." : "No tags yet."}</p>
        )}
        <ul className="pg-settings-list" aria-label="Tags">
          {active.map((t) => (
            <li key={t.id}>
              {renaming?.id === t.id ? (
                <form
                  className="pg-settings-row"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (
                      await run(
                        { id: t.id, name: renaming.name },
                        `Renamed ${t.name} to ${renaming.name.trim()}.`,
                      )
                    )
                      setRenaming(null);
                  }}
                >
                  <input
                    aria-label={`New name for ${t.name}`}
                    value={renaming.name}
                    maxLength={60}
                    required
                    autoFocus
                    onChange={(e) =>
                      setRenaming({ id: t.id, name: e.target.value })
                    }
                  />
                  <span className="pg-settings-buttons">
                    <button
                      type="submit"
                      className="pg-primary"
                      disabled={busy}
                    >
                      Save
                    </button>
                    <button type="button" onClick={() => setRenaming(null)}>
                      Cancel
                    </button>
                  </span>
                </form>
              ) : (
                <>
                  <span>
                    <strong>{t.name}</strong>
                    <small className="pg-muted">
                      {plural(t.conversations, "conversation")}
                    </small>
                  </span>
                  <span className="pg-settings-buttons">
                    <button
                      type="button"
                      aria-label={`Rename ${t.name}`}
                      onClick={() => setRenaming({ id: t.id, name: t.name })}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Archive ${t.name}`}
                      onClick={() =>
                        void run(
                          { id: t.id, action: "archive" },
                          `Archived ${t.name}. It stays on ${plural(t.conversations, "conversation")} and can't be added again.`,
                        )
                      }
                    >
                      Archive
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {archived.length > 0 && (
        <Card
          title="Archived tags"
          description="Still on the conversations that had them, and in their history. Restore one to add it again."
        >
          <ul className="pg-settings-list" aria-label="Archived tags">
            {archived.map((t) => (
              <li key={t.id}>
                <span>
                  <strong>{t.name}</strong>
                  <small className="pg-muted">
                    {plural(t.conversations, "conversation")}
                  </small>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Restore ${t.name}`}
                  onClick={() =>
                    void run(
                      { id: t.id, action: "restore" },
                      `Restored ${t.name}.`,
                    )
                  }
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Frame>
  );
}

export function AttributesPage({
  menu,
  page,
}: {
  menu: MenuState;
  page: Page;
}) {
  const { items, error, notice, busy, run, load, setNotice } =
    useList<Attribute>("attributes", "attributes");
  const [editing, setEditing] = useState<Attribute | "new" | null>(null);
  const active = (items ?? []).filter((a) => !a.archived);
  const archived = (items ?? []).filter((a) => a.archived);
  return (
    <Frame menu={menu} page={page}>
      <Messages error={error} notice={notice} />
      <Card
        title="Conversation attributes"
        description="Details teammates fill in on a conversation, shown in its sidebar and usable in views, SLAs and macros. An attribute used as a ticket field shows with the ticket instead."
      >
        {items && !active.length && (
          <p className="pg-muted">No attributes yet.</p>
        )}
        <ul className="pg-settings-list" aria-label="Attributes">
          {active.map((a) => (
            <li key={a.id}>
              <span>
                <strong>{a.name}</strong>
                <small className="pg-muted">
                  {typeName(a.valueType)}
                  {a.valueType === "options" && `: ${a.options.join(", ")}`}
                  {a.ticketTypes.length > 0 &&
                    ` · field on ${a.ticketTypes.join(", ")}`}
                </small>
              </span>
              <span className="pg-settings-buttons">
                <button
                  type="button"
                  aria-label={`Edit ${a.name}`}
                  onClick={() => setEditing(a)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Archive ${a.name}`}
                  onClick={() =>
                    void run(
                      { id: a.id, action: "archive" },
                      `Archived ${a.name}. Conversations keep their values, but it's no longer shown or filled in${a.ticketTypes.length ? `, including on ${a.ticketTypes.join(", ")} tickets` : ""}.`,
                    )
                  }
                >
                  Archive
                </button>
              </span>
            </li>
          ))}
        </ul>
        {!editing && (
          <div>
            <button type="button" onClick={() => setEditing("new")}>
              New attribute
            </button>
          </div>
        )}
      </Card>
      {editing && (
        <AttributeEditor
          key={editing === "new" ? "new" : editing.id}
          attribute={editing === "new" ? null : editing}
          onSaved={(text) => {
            setEditing(null);
            setNotice(text);
            void load();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {archived.length > 0 && (
        <Card
          title="Archived attributes"
          description="Conversations keep the values they had. Restore one to show and fill it in again."
        >
          <ul className="pg-settings-list" aria-label="Archived attributes">
            {archived.map((a) => (
              <li key={a.id}>
                <span>
                  <strong>{a.name}</strong>
                  <small className="pg-muted">{typeName(a.valueType)}</small>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Restore ${a.name}`}
                  onClick={() =>
                    void run(
                      { id: a.id, action: "restore" },
                      `Restored ${a.name}.`,
                    )
                  }
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Frame>
  );
}

function AttributeEditor({
  attribute,
  onSaved,
  onCancel,
}: {
  attribute: Attribute | null;
  onSaved: (notice: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(attribute?.name ?? "");
  const [valueType, setValueType] = useState<ValueType>(
    attribute?.valueType ?? "string",
  );
  const kept = attribute?.options ?? [];
  const [added, setAdded] = useState<string[]>([]);
  const [option, setOption] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function addOption() {
    const o = option.trim().replace(/\s+/g, " ");
    if (!o) return;
    if ([...kept, ...added].some((x) => x.toLowerCase() === o.toLowerCase())) {
      setError(`“${o}” is already an option.`);
      return;
    }
    setError("");
    setAdded([...added, o]);
    setOption("");
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api("attributes", {
        ...(attribute ? { id: attribute.id } : { valueType }),
        name,
        ...(valueType === "options" ? { options: [...kept, ...added] } : {}),
      });
      onSaved(`Saved ${name.trim()}.`);
    } catch (e) {
      setError(message(e, "The attribute could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="pg-settings-card"
      aria-label={attribute ? `Edit ${attribute.name}` : "New attribute"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>{attribute ? `Edit ${attribute.name}` : "New attribute"}</h3>
      <Field label="Attribute name">
        {(id) => (
          <input
            id={id}
            value={name}
            maxLength={80}
            required
            placeholder="Order number"
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <fieldset className="pg-settings-fieldset">
        <legend>Type</legend>
        <p className="pg-muted pg-settings-small">
          {attribute
            ? "The type is fixed: conversations already hold values of this type."
            : "Fixed once created, because conversations store values of this type."}
        </p>
        {TYPES.map(([value, label, help]) => (
          <label key={value} className="pg-settings-toggle">
            <input
              type="radio"
              name="attribute-type"
              checked={valueType === value}
              disabled={!!attribute}
              onChange={() => setValueType(value)}
            />
            <span>
              <strong>{label}</strong>
              <small className="pg-muted">{help}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {valueType === "options" && (
        <fieldset className="pg-settings-fieldset">
          <legend>Options</legend>
          <p className="pg-muted pg-settings-small">
            Options can be added later, but not renamed or removed once saved:
            conversations keep the option they were given.
          </p>
          <ul className="pg-settings-chips" aria-label="Options">
            {kept.map((o) => (
              <li key={o} className="pg-settings-chip">
                {o}
              </li>
            ))}
            {added.map((o) => (
              <li key={o} className="pg-settings-chip">
                {o}
                <button
                  type="button"
                  aria-label={`Remove option ${o}`}
                  onClick={() => setAdded(added.filter((x) => x !== o))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="pg-settings-row">
            <input
              aria-label="New option"
              placeholder="New option"
              value={option}
              maxLength={100}
              onChange={(e) => setOption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addOption();
                }
              }}
            />
            <button type="button" onClick={addOption}>
              Add option
            </button>
          </div>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <footer className="pg-settings-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="pg-primary" disabled={busy}>
          {attribute ? "Save attribute" : "Create attribute"}
        </button>
      </footer>
    </form>
  );
}

// Ticket types --------------------------------------------------------------------------------

type Kind = "submitted" | "in_progress" | "waiting_on_customer" | "resolved";
type Category = "customer" | "back_office" | "tracker";
type TicketType = {
  id: string;
  name: string;
  icon: string;
  category: Category;
  description: string;
  version: string;
  portal_visible: boolean;
  portal_visibility: string | null;
  states: {
    id: string;
    name: string;
    customerLabel: string;
    kind: Kind;
    position: number;
  }[];
  transitions: [string, string][];
  fields: {
    attributeId: string;
    name: string;
    valueType: ValueType;
    requiredToClose: boolean;
  }[];
};
/** A state being edited: its key is kept from the stored id, or made from the name on save. */
type StateDraft = {
  uid: string;
  key: string;
  name: string;
  customerLabel: string;
  kind: Kind;
};
const KINDS: [Kind, string][] = [
  ["submitted", "Submitted"],
  ["in_progress", "In progress"],
  ["waiting_on_customer", "Waiting on customer"],
  ["resolved", "Resolved"],
];
const CATEGORY: [Category, string, string][] = [
  [
    "customer",
    "Customer",
    "Raised for a customer, who sees its state and is told when it changes.",
  ],
  [
    "back_office",
    "Back-office",
    "Internal work for a customer's conversation, such as a refund approval. The customer never sees it.",
  ],
  [
    "tracker",
    "Tracker",
    "One issue linked to many conversations, such as an outage, updated for all of them at once. Internal.",
  ],
];
const categoryName = (c: Category) => CATEGORY.find(([v]) => v === c)?.[1] ?? c;
const KEY = /^[a-z0-9_-]{1,40}$/;
const keyFrom = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 36) || "state";
let uidSeq = 0;
const uid = () => "s" + ++uidSeq;

export function TicketTypesPage({
  menu,
  page,
}: {
  menu: MenuState;
  page: Page;
}) {
  const { items, error, notice, busy, run, load, setNotice } =
    useList<TicketType>("ticket-types", "types");
  const [editing, setEditing] = useState<TicketType | "new" | null>(null);
  const [attributes, setAttributes] = useState<Attribute[]>([]);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    api<{ attributes: Attribute[] }>("attributes")
      .then((r) => setAttributes(r.attributes.filter((a) => !a.archived)))
      .catch(() => setAttributes([]));
  }, [reload]);
  return (
    <Frame menu={menu} page={page}>
      <Messages error={error} notice={notice} />
      <Card
        title="Ticket types"
        description="Each type has its own states, the moves allowed between them, and fields to fill in. A ticket's type can be changed on the ticket."
      >
        {items && !items.length && (
          <p className="pg-muted">No ticket types yet.</p>
        )}
        <ul className="pg-settings-list" aria-label="Ticket types">
          {items?.map((t) => (
            <li key={t.id}>
              <span>
                <strong>{t.name}</strong>
                <small className="pg-muted">
                  {categoryName(t.category)} ·{" "}
                  {t.states.map((s) => s.name).join(" → ")}
                  {t.fields.length > 0 &&
                    ` · ${plural(t.fields.length, "field")}`}
                  {t.category === "customer" &&
                    (t.portal_visible
                      ? " · in the portal"
                      : " · not in the portal")}
                </small>
              </span>
              <span className="pg-settings-buttons">
                <button
                  type="button"
                  aria-label={`Edit ${t.name}`}
                  onClick={() => setEditing(t)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Archive ${t.name}`}
                  onClick={() =>
                    void run(
                      { action: "archive", id: t.id, version: t.version },
                      `Archived ${t.name}. Its tickets keep it; new tickets can't use it.`,
                    )
                  }
                >
                  Archive
                </button>
              </span>
            </li>
          ))}
        </ul>
        {!editing && (
          <div>
            <button type="button" onClick={() => setEditing("new")}>
              New ticket type
            </button>
          </div>
        )}
      </Card>
      {editing && (
        <TicketTypeEditor
          key={editing === "new" ? "new" : editing.id + editing.version}
          type={editing === "new" ? null : editing}
          attributes={attributes}
          onSaved={(name) => {
            setEditing(null);
            setReload((n) => n + 1);
            setNotice(`Saved ${name}.`);
            void load();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </Frame>
  );
}

const draftsOf = (t: TicketType | null): StateDraft[] =>
  t
    ? [...t.states]
        .sort((a, b) => a.position - b.position)
        .map((s) => ({
          uid: s.id,
          key: s.id.slice(t.id.length + 1),
          name: s.name,
          customerLabel: s.customerLabel,
          kind: s.kind,
        }))
    : [
        {
          uid: uid(),
          key: "",
          name: "Submitted",
          customerLabel: "Submitted",
          kind: "submitted",
        },
        {
          uid: uid(),
          key: "",
          name: "In progress",
          customerLabel: "In progress",
          kind: "in_progress",
        },
        {
          uid: uid(),
          key: "",
          name: "Resolved",
          customerLabel: "Resolved",
          kind: "resolved",
        },
      ];

function TicketTypeEditor({
  type,
  attributes,
  onSaved,
  onCancel,
}: {
  type: TicketType | null;
  attributes: Attribute[];
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(type?.name ?? "");
  const [description, setDescription] = useState(type?.description ?? "");
  const [category, setCategory] = useState<Category>(
    type?.category ?? "customer",
  );
  const [portalVisible, setPortalVisible] = useState(
    type?.portal_visible ?? true,
  );
  const [portalVisibility, setPortalVisibility] = useState(
    type?.portal_visibility ?? "",
  );
  const [states, setStates] = useState<StateDraft[]>(() => draftsOf(type));
  // Moves between states, by draft uid. A new type starts with every move allowed.
  const [moves, setMoves] = useState<Set<string>>(() => {
    if (!type) {
      const all = new Set<string>();
      for (const a of states)
        for (const b of states) if (a !== b) all.add(a.uid + ">" + b.uid);
      return all;
    }
    return new Set(type.transitions.map(([a, b]) => a + ">" + b));
  });
  const [fields, setFields] = useState<Map<string, boolean>>(
    () =>
      new Map(
        type?.fields.map((f) => [f.attributeId, f.requiredToClose]) ?? [],
      ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const update = (i: number, change: Partial<StateDraft>) =>
    setStates(states.map((s, j) => (j === i ? { ...s, ...change } : s)));
  function move(i: number, by: -1 | 1) {
    const next = [...states];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s);
    setStates(next);
  }
  function remove(i: number) {
    const gone = states[i].uid;
    setStates(states.filter((_, j) => j !== i));
    setMoves(new Set([...moves].filter((m) => !m.split(">").includes(gone))));
  }
  function addState() {
    const s: StateDraft = {
      uid: uid(),
      key: "",
      name: "",
      customerLabel: "",
      kind: "in_progress",
    };
    // A new state can move to and from every other state; untick what shouldn't be allowed.
    const next = new Set(moves);
    for (const o of states) {
      next.add(s.uid + ">" + o.uid);
      next.add(o.uid + ">" + s.uid);
    }
    setMoves(next);
    setStates([...states, s]);
  }
  const toggleMove = (from: string, to: string, on: boolean) => {
    const next = new Set(moves);
    if (on) next.add(from + ">" + to);
    else next.delete(from + ">" + to);
    setMoves(next);
  };

  async function save() {
    // Keys: kept for stored states; new ones from the name, unique within the type.
    const used = new Set(states.filter((s) => s.key).map((s) => s.key));
    const keyed = states.map((s) => {
      if (s.key) return s;
      let key = keyFrom(s.name);
      for (let n = 2; used.has(key); n++) key = `${keyFrom(s.name)}_${n}`;
      used.add(key);
      return { ...s, key };
    });
    if (keyed.some((s) => !KEY.test(s.key))) {
      setError("Each state needs a name.");
      return;
    }
    const keyOf = new Map(keyed.map((s) => [s.uid, s.key]));
    const transitions = [...moves]
      .map((m) => m.split(">"))
      .filter(([a, b]) => keyOf.has(a) && keyOf.has(b))
      .map(([a, b]) => [keyOf.get(a)!, keyOf.get(b)!]);
    setBusy(true);
    setError("");
    try {
      await api("ticket-types", {
        ...(type ? { id: type.id, version: type.version } : { category }),
        name,
        icon: type?.icon ?? "ticket",
        description,
        states: keyed.map((s) => ({
          key: s.key,
          name: s.name,
          customerLabel: s.customerLabel || s.name,
          kind: s.kind,
        })),
        transitions,
        portalVisible: category === "customer" ? portalVisible : false,
        portalVisibility:
          category === "customer" && portalVisibility ? portalVisibility : null,
        fields: [...fields].map(([attributeId, requiredToClose]) => ({
          attributeId,
          requiredToClose,
        })),
      });
      onSaved(name.trim());
    } catch (e) {
      setError(message(e, "The ticket type could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  // Fields: active attributes, plus those already on the type (kept even if the attribute
  // list can't be read, as for a teammate who manages tickets but not the workspace).
  const choices = [
    ...attributes.map((a) => ({
      id: a.id,
      name: a.name,
      valueType: a.valueType,
    })),
    ...(type?.fields ?? [])
      .filter((f) => !attributes.some((a) => a.id === f.attributeId))
      .map((f) => ({
        id: f.attributeId,
        name: f.name,
        valueType: f.valueType,
      })),
  ];
  return (
    <form
      className="pg-settings-card"
      aria-label={type ? `Edit ${type.name}` : "New ticket type"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>{type ? `Edit ${type.name}` : "New ticket type"}</h3>
      <Field label="Type name">
        {(id) => (
          <input
            id={id}
            value={name}
            maxLength={80}
            required
            placeholder="Bug report"
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <Field label="Description" hint="Shown to teammates choosing a type.">
        {(id, hint) => (
          <textarea
            id={id}
            aria-describedby={hint}
            rows={2}
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        )}
      </Field>
      <fieldset className="pg-settings-fieldset">
        <legend>Category</legend>
        <p className="pg-muted pg-settings-small">
          {type
            ? "Fixed once created, because it decides who can see the tickets."
            : "Fixed once created."}
        </p>
        {CATEGORY.map(([value, label, help]) => (
          <label key={value} className="pg-settings-toggle">
            <input
              type="radio"
              name="ticket-category"
              checked={category === value}
              disabled={!!type}
              onChange={() => setCategory(value)}
            />
            <span>
              <strong>{label}</strong>
              <small className="pg-muted">{help}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {category === "customer" && (
        <fieldset className="pg-settings-fieldset">
          <legend>Customer portal</legend>
          <label className="pg-settings-toggle">
            <input
              type="checkbox"
              checked={portalVisible}
              onChange={(e) => setPortalVisible(e.target.checked)}
            />
            <span>
              <strong>Show these tickets in the portal</strong>
              <small className="pg-muted">
                Customers see the ticket&apos;s number, type and state, never
                notes or internal state names.
              </small>
            </span>
          </label>
          {portalVisible && (
            <Field label="Who can see them">
              {(id) => (
                <select
                  id={id}
                  value={portalVisibility}
                  onChange={(e) => setPortalVisibility(e.target.value)}
                >
                  <option value="">The portal&apos;s default</option>
                  <option value="individual">
                    Only the person who raised it
                  </option>
                  <option value="company">Everyone at their company</option>
                </select>
              )}
            </Field>
          )}
        </fieldset>
      )}
      <fieldset className="pg-settings-fieldset">
        <legend>States</legend>
        <p className="pg-muted pg-settings-small">
          In order. A type needs at least one resolved state and one that
          isn&apos;t. What customers see can differ from the name teammates see.
          A state with tickets in it can&apos;t be removed.
        </p>
        <table className="pg-settings-table pg-settings-states">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Customers see</th>
              <th scope="col">Kind</th>
              <th scope="col">
                <span className="pg-visually-hidden">Order and remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {states.map((s, i) => (
              <tr key={s.uid}>
                <td>
                  <input
                    aria-label={`State ${i + 1} name`}
                    value={s.name}
                    maxLength={60}
                    required
                    onChange={(e) => update(i, { name: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    aria-label={`State ${i + 1} customer label`}
                    value={s.customerLabel}
                    maxLength={60}
                    placeholder={s.name}
                    onChange={(e) =>
                      update(i, { customerLabel: e.target.value })
                    }
                  />
                </td>
                <td>
                  <select
                    aria-label={`State ${i + 1} kind`}
                    value={s.kind}
                    onChange={(e) =>
                      update(i, { kind: e.target.value as Kind })
                    }
                  >
                    {KINDS.map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="pg-settings-buttons">
                  <button
                    type="button"
                    aria-label={`Move state ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move state ${i + 1} down`}
                    disabled={i === states.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove state ${i + 1}`}
                    disabled={states.length <= 2}
                    onClick={() => remove(i)}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div>
          <button
            type="button"
            onClick={addState}
            disabled={states.length >= 30}
          >
            Add state
          </button>
        </div>
      </fieldset>
      <fieldset className="pg-settings-fieldset">
        <legend>Moves between states</legend>
        <p className="pg-muted pg-settings-small">
          Where a ticket can go from each state. Every state that isn&apos;t
          resolved needs a way to reach a resolved one.
        </p>
        {states.map((from) => (
          <div key={from.uid} className="pg-settings-day">
            <strong>From {from.name || "(unnamed)"}</strong>
            <div
              className="pg-settings-checks"
              role="group"
              aria-label={`From ${from.name || "(unnamed)"}`}
            >
              {states
                .filter((to) => to !== from)
                .map((to) => (
                  <label key={to.uid}>
                    <input
                      type="checkbox"
                      checked={moves.has(from.uid + ">" + to.uid)}
                      onChange={(e) =>
                        toggleMove(from.uid, to.uid, e.target.checked)
                      }
                    />
                    {to.name || "(unnamed)"}
                  </label>
                ))}
            </div>
          </div>
        ))}
      </fieldset>
      <fieldset className="pg-settings-fieldset">
        <legend>Fields</legend>
        <p className="pg-muted pg-settings-small">
          Conversation attributes filled in on these tickets. A field shows with
          the ticket instead of in the conversation&apos;s details; required
          ones must be filled in before the ticket is resolved. Add attributes
          in Settings › Attributes.
        </p>
        {!choices.length && <p className="pg-muted">No attributes yet.</p>}
        {choices.map((a) => {
          const on = fields.has(a.id);
          return (
            <div key={a.id} className="pg-settings-field-choice">
              <label>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => {
                    const next = new Map(fields);
                    if (e.target.checked) next.set(a.id, false);
                    else next.delete(a.id);
                    setFields(next);
                  }}
                />
                {a.name}
                <small className="pg-muted"> · {typeName(a.valueType)}</small>
              </label>
              {on && (
                <label>
                  <input
                    type="checkbox"
                    checked={fields.get(a.id) === true}
                    onChange={(e) =>
                      setFields(new Map(fields).set(a.id, e.target.checked))
                    }
                  />
                  Required to resolve
                </label>
              )}
            </div>
          );
        })}
      </fieldset>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <footer className="pg-settings-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="pg-primary" disabled={busy}>
          {type ? "Save ticket type" : "Create ticket type"}
        </button>
      </footer>
    </form>
  );
}
