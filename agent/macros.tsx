import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api, InboxError } from "./api";
import { VARIABLE_LABELS } from "./variables";
import type { ComposerHandle } from "./composer";
import type { Directory } from "./timeline";
import { MACRO_VARIABLES, type RichDoc } from "../lib/rich-doc";

const Composer = lazy(() =>
  import("./composer").then((m) => ({ default: m.Composer })),
);

export type MacroAction =
  | { type: "assign"; teammateId?: string; teamId?: string }
  | { type: "tag_add" | "tag_remove"; tagId: string }
  | { type: "priority"; value: boolean }
  | { type: "snooze"; preset: "later_today" | "tomorrow" | "next_week" }
  | { type: "close" | "reopen" }
  | { type: "ticket_state"; stateId: string };
export type Macro = {
  id: string;
  owner_id: string;
  shared: boolean;
  name: string;
  mode: "reply" | "note";
  body: RichDoc | null;
  actions: MacroAction[];
  version: string;
  canEdit: boolean;
  canDelete: boolean;
};
export type MacroList = { macros: Macro[]; canCreateShared: boolean };

function Dialog({
  label,
  onClose,
  wide,
  children,
}: {
  label: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  // Escape closes the dialog wherever focus is, including after the focused control
  // (such as Save) has been removed and focus has fallen back to the page.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // An Escape already handled inside (the editor leaving focus) does not close the dialog,
      // so unsaved macro text is never lost to one keypress.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.stopPropagation();
      close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div
      className="pg-modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={wide ? "pg-dialog pg-dialog-wide" : "pg-dialog"}
      >
        {children}
      </section>
    </div>
  );
}

/** Search and apply a macro with the keyboard: type to filter, arrows to move, Enter to apply. */
export function MacroPicker({
  list,
  onApply,
  onManage,
  onClose,
}: {
  list: MacroList | null;
  onApply: (macro: Macro) => void;
  onManage: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const matches = (list?.macros ?? []).filter((m) =>
    m.name.toLowerCase().includes(query.toLowerCase()),
  );
  const current = Math.min(active, Math.max(0, matches.length - 1));
  const choose = (m?: Macro) => {
    if (!m) return;
    onClose();
    onApply(m);
  };
  return (
    <Dialog label="Apply a macro" onClose={onClose}>
      <input
        ref={input}
        role="combobox"
        aria-expanded="true"
        aria-controls="pg-macro-list"
        aria-activedescendant={
          matches[current] ? "pg-macro-" + matches[current].id : undefined
        }
        aria-label="Search macros"
        placeholder="Search macros…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((current + 1) % Math.max(1, matches.length));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive(
              (current - 1 + matches.length) % Math.max(1, matches.length),
            );
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(matches[current]);
          }
        }}
      />
      <ul
        id="pg-macro-list"
        role="listbox"
        aria-label="Macros"
        className="pg-palette"
      >
        {!list ? (
          <li className="pg-empty">Loading…</li>
        ) : matches.length ? (
          matches.map((m, i) => (
            <li
              key={m.id}
              id={"pg-macro-" + m.id}
              role="option"
              aria-selected={i === current}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(m)}
            >
              <span>{m.name}</span>
              <small>
                {m.mode === "note" ? "Note" : "Reply"}
                {m.actions.length
                  ? ` · ${m.actions.length} action${m.actions.length > 1 ? "s" : ""}`
                  : ""}
                {m.shared ? " · Shared" : " · Personal"}
              </small>
            </li>
          ))
        ) : (
          <li className="pg-empty">No macros match.</li>
        )}
      </ul>
      <button
        onClick={() => {
          onClose();
          onManage();
        }}
      >
        Manage macros
      </button>
    </Dialog>
  );
}

const ACTION_TYPES: [MacroAction["type"], string][] = [
  ["assign", "Assign"],
  ["tag_add", "Add tag"],
  ["tag_remove", "Remove tag"],
  ["priority", "Priority"],
  ["snooze", "Snooze"],
  ["close", "Close"],
  ["reopen", "Reopen"],
  ["ticket_state", "Ticket state"],
];
const blankAction = (
  type: MacroAction["type"],
  dir: Directory,
): MacroAction => {
  switch (type) {
    case "assign":
      return { type, teammateId: dir.teammates[0]?.id };
    case "tag_add":
    case "tag_remove":
      return { type, tagId: dir.tags[0]?.id ?? "" };
    case "priority":
      return { type, value: true };
    case "snooze":
      return { type, preset: "tomorrow" };
    case "ticket_state":
      return { type, stateId: dir.ticketStates?.[0]?.id ?? "" };
    default:
      return { type };
  }
};

function ActionRow({
  action,
  dir,
  onChange,
  onRemove,
  index,
}: {
  action: MacroAction;
  dir: Directory;
  onChange: (a: MacroAction) => void;
  onRemove: () => void;
  index: number;
}) {
  const n = index + 1;
  return (
    <div className="pg-action-row">
      <select
        aria-label={`Action ${n} type`}
        value={action.type}
        onChange={(e) =>
          onChange(blankAction(e.target.value as MacroAction["type"], dir))
        }
      >
        {ACTION_TYPES.filter(
          ([type]) => type !== "ticket_state" || dir.ticketStates?.length,
        ).map(([type, label]) => (
          <option key={type} value={type}>
            {label}
          </option>
        ))}
      </select>
      {action.type === "assign" && (
        <select
          aria-label={`Action ${n} assignee`}
          value={
            action.teamId
              ? "team:" + action.teamId
              : "teammate:" + (action.teammateId ?? "")
          }
          onChange={(e) => {
            const [kind, id] = e.target.value.split(":");
            onChange(
              kind === "team"
                ? { type: "assign", teamId: id }
                : { type: "assign", teammateId: id || undefined },
            );
          }}
        >
          <option value="teammate:">Unassigned</option>
          {dir.teammates.map((t) => (
            <option key={t.id} value={"teammate:" + t.id}>
              {t.name}
            </option>
          ))}
          {dir.teams.map((t) => (
            <option key={t.id} value={"team:" + t.id}>
              Team {t.name}
            </option>
          ))}
        </select>
      )}
      {(action.type === "tag_add" || action.type === "tag_remove") && (
        <select
          aria-label={`Action ${n} tag`}
          value={action.tagId}
          onChange={(e) => onChange({ ...action, tagId: e.target.value })}
        >
          {dir.tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      {action.type === "priority" && (
        <select
          aria-label={`Action ${n} priority`}
          value={String(action.value)}
          onChange={(e) =>
            onChange({ type: "priority", value: e.target.value === "true" })
          }
        >
          <option value="true">Mark as priority</option>
          <option value="false">Remove priority</option>
        </select>
      )}
      {action.type === "snooze" && (
        <select
          aria-label={`Action ${n} snooze`}
          value={action.preset}
          onChange={(e) =>
            onChange({ type: "snooze", preset: e.target.value as "tomorrow" })
          }
        >
          <option value="later_today">Later today</option>
          <option value="tomorrow">Tomorrow 09:00</option>
          <option value="next_week">Next Monday 09:00</option>
        </select>
      )}
      {action.type === "ticket_state" && (
        <select
          aria-label={`Action ${n} ticket state`}
          value={action.stateId}
          onChange={(e) =>
            onChange({ type: "ticket_state", stateId: e.target.value })
          }
        >
          {(dir.ticketStates ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        aria-label={`Remove action ${n}`}
        onClick={onRemove}
      >
        Remove
      </button>
    </div>
  );
}

function MacroEditor({
  macro,
  canShare,
  dir,
  onSaved,
  onCancel,
}: {
  macro: Macro | null;
  canShare: boolean;
  dir: Directory;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(macro?.name ?? "");
  const [mode, setMode] = useState<"reply" | "note">(macro?.mode ?? "reply");
  const [shared, setShared] = useState(macro?.shared ?? false);
  const [body, setBody] = useState<RichDoc | null>(macro?.body ?? null);
  const [actions, setActions] = useState<MacroAction[]>(macro?.actions ?? []);
  const [variable, setVariable] = useState<string>(MACRO_VARIABLES[1]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const editor = useRef<ComposerHandle>(null);
  const save = async (archive = false) => {
    setBusy(true);
    setError("");
    try {
      await api(
        "macros",
        archive
          ? { action: "archive", id: macro!.id, version: macro!.version }
          : {
              action: "save",
              ...(macro ? { id: macro.id, version: macro.version } : {}),
              name,
              mode,
              shared,
              body,
              actions,
            },
      );
      onSaved();
    } catch (e) {
      setError(
        e instanceof InboxError || e instanceof Error
          ? e.message
          : "The macro could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pg-macro-editor">
      <h3>{macro ? "Edit macro" : "New macro"}</h3>
      <label>
        Name
        <input
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        Insert as
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as "reply" | "note")}
        >
          <option value="reply">Reply</option>
          <option value="note">Internal note</option>
        </select>
      </label>
      {(canShare || macro?.shared) && (
        <label>
          <input
            type="checkbox"
            checked={shared}
            disabled={!!macro?.shared}
            onChange={(e) => setShared(e.target.checked)}
          />{" "}
          Shared with the workspace
        </label>
      )}
      <div className="pg-variable-bar">
        <select
          aria-label="Variable"
          value={variable}
          onChange={(e) => setVariable(e.target.value)}
        >
          {MACRO_VARIABLES.map((v) => (
            <option key={v} value={v}>
              {VARIABLE_LABELS[v]}
            </option>
          ))}
        </select>
        <button
          type="button"
          // Keep focus in the editor: a focused button would be pressed again by the next space.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() =>
            editor.current?.insertVariable?.(
              variable,
              variable.startsWith("contact.") ? "there" : "",
            )
          }
        >
          Insert variable
        </button>
      </div>
      <Suspense
        fallback={
          <div className="pg-editor-shell" aria-busy="true">
            Loading editor…
          </div>
        }
      >
        <Composer
          handleRef={editor}
          label="Macro text"
          placeholder="Text to insert…"
          value={{ key: macro?.id ?? "new", doc: body }}
          disabled={busy}
          onChange={setBody}
          onSubmit={() => void save()}
          onFiles={() => setError("Images cannot be added to macros yet.")}
          imageStatus={() => undefined}
          mentionables={null}
          variables
        />
      </Suspense>
      <fieldset className="pg-actions">
        <legend>Actions</legend>
        {actions.map((a, i) => (
          <ActionRow
            key={i}
            index={i}
            action={a}
            dir={dir}
            onChange={(next) =>
              setActions((list) => list.map((x, j) => (j === i ? next : x)))
            }
            onRemove={() =>
              setActions((list) => list.filter((_, j) => j !== i))
            }
          />
        ))}
        {actions.length < 10 && (
          <button
            type="button"
            onClick={() =>
              setActions((list) => [...list, blankAction("tag_add", dir)])
            }
          >
            Add action
          </button>
        )}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <footer>
        {macro?.canDelete && (
          <button type="button" disabled={busy} onClick={() => void save(true)}>
            Archive
          </button>
        )}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={() => void save()}
        >
          Save macro
        </button>
      </footer>
    </div>
  );
}

/** Lists the teammate's personal macros and the workspace's shared ones, with an editor. */
export function MacroManager({
  list,
  dir,
  onChanged,
  onClose,
}: {
  list: MacroList | null;
  dir: Directory;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<Macro | "new" | null>(null);
  const group = (shared: boolean) =>
    (list?.macros ?? []).filter((m) => m.shared === shared);
  return (
    <Dialog label="Macros" onClose={onClose} wide>
      <header className="pg-notifications-head">
        <h2>Macros</h2>
        {!editing && (
          <button onClick={() => setEditing("new")}>New macro</button>
        )}
      </header>
      {editing ? (
        <MacroEditor
          key={editing === "new" ? "new" : editing.id}
          macro={editing === "new" ? null : editing}
          canShare={list?.canCreateShared ?? false}
          dir={dir}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        [
          ["Personal", group(false)],
          ["Shared", group(true)],
        ].map(([title, items]) => (
          <section key={title as string} className="pg-macro-group">
            <h3>{title as string}</h3>
            {(items as Macro[]).length ? (
              <ul>
                {(items as Macro[]).map((m) => (
                  <li key={m.id}>
                    <span>{m.name}</span>
                    {m.canEdit ? (
                      <button
                        aria-label={"Edit " + m.name}
                        onClick={() => setEditing(m)}
                      >
                        Edit
                      </button>
                    ) : (
                      <small>View only</small>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pg-empty">None yet.</p>
            )}
          </section>
        ))
      )}
    </Dialog>
  );
}
