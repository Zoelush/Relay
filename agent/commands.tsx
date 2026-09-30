import { useEffect, useRef, useState } from "react";

export type PaletteCommand = {
  id: string;
  label: string;
  group: string;
  keys?: string;
  run: () => void;
};

/** Shortcuts, as shown on the sheet. The handler lives in the inbox. */
export const SHORTCUTS: [string, string][] = [
  ["J / K", "Next / previous conversation"],
  ["R", "Reply"],
  ["N", "Internal note"],
  ["⌘ Enter", "Send (while writing)"],
  ["E", "Close conversation"],
  ["Shift E", "Reopen conversation"],
  ["S", "Snooze"],
  ["A", "Assign to me"],
  ["P", "Toggle priority"],
  ["/", "Search this view"],
  ["⌘ K", "Command palette"],
  ["?", "This shortcut sheet"],
  ["Esc", "Close a dialog"],
];

/** True when a key press belongs to text entry, including IME composition. */
export function typing(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return (
    e.isComposing ||
    !!t?.closest("input, textarea, select, [contenteditable='true']")
  );
}

function Dialog({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="pg-modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="pg-dialog"
      >
        {children}
      </section>
    </div>
  );
}

export function CommandPalette({
  commands,
  onClose,
}: {
  commands: PaletteCommand[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = commands
    .filter((c) =>
      words.every((w) => (c.group + " " + c.label).toLowerCase().includes(w)),
    )
    .slice(0, 50);
  const current = Math.min(active, Math.max(0, matches.length - 1));
  const run = (c: PaletteCommand | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  return (
    <Dialog label="Command palette" onClose={onClose}>
      <input
        ref={input}
        role="combobox"
        aria-expanded="true"
        aria-controls="pg-palette-list"
        aria-activedescendant={
          matches[current] ? "pg-cmd-" + matches[current].id : undefined
        }
        aria-label="Search commands"
        placeholder="Type a command…"
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
            run(matches[current]);
          }
        }}
      />
      <ul
        id="pg-palette-list"
        role="listbox"
        aria-label="Commands"
        className="pg-palette"
      >
        {matches.map((c, i) => (
          <li
            key={c.id}
            id={"pg-cmd-" + c.id}
            role="option"
            aria-selected={i === current}
            onMouseEnter={() => setActive(i)}
            onClick={() => run(c)}
          >
            <span>{c.label}</span>
            <small>{c.keys ?? c.group}</small>
          </li>
        ))}
        {!matches.length && <li className="pg-empty">No matching commands.</li>}
      </ul>
    </Dialog>
  );
}

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  return (
    <Dialog label="Keyboard shortcuts" onClose={onClose}>
      <h2>Keyboard shortcuts</h2>
      <dl className="pg-shortcuts">
        {SHORTCUTS.map(([keys, action]) => (
          <div key={keys}>
            <dt>
              <kbd>{keys}</kbd>
            </dt>
            <dd>{action}</dd>
          </div>
        ))}
      </dl>
      <button ref={close} onClick={onClose}>
        Close
      </button>
    </Dialog>
  );
}

export type SnoozeChoice =
  { preset: "later_today" | "tomorrow" | "next_week" } | { wakeAt: string };

export function SnoozeMenu({
  onSnooze,
  onClose,
}: {
  onSnooze: (choice: SnoozeChoice, unassignOnWake: boolean) => void;
  onClose: () => void;
}) {
  const [unassign, setUnassign] = useState(false);
  const [custom, setCustom] = useState("");
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const choose = (choice: SnoozeChoice) => {
    onClose();
    onSnooze(choice, unassign);
  };
  return (
    <Dialog label="Snooze conversation" onClose={onClose}>
      <h2>Snooze until…</h2>
      <div className="pg-snooze">
        <button ref={first} onClick={() => choose({ preset: "later_today" })}>
          Later today <small>in 3 hours</small>
        </button>
        <button onClick={() => choose({ preset: "tomorrow" })}>
          Tomorrow <small>09:00</small>
        </button>
        <button onClick={() => choose({ preset: "next_week" })}>
          Next week <small>Monday 09:00</small>
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            // datetime-local is wall time in this browser's zone; send it with an explicit offset.
            if (custom) choose({ wakeAt: new Date(custom).toISOString() });
          }}
        >
          <label>
            Custom time
            <input
              type="datetime-local"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
          </label>
          <button disabled={!custom}>Snooze</button>
        </form>
        <label>
          <input
            type="checkbox"
            checked={unassign}
            onChange={(e) => setUnassign(e.target.checked)}
          />{" "}
          Unassign when it wakes
        </label>
      </div>
    </Dialog>
  );
}
