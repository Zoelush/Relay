import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Check, Search } from "lucide-react";

/**
 * A button that opens a menu of choices: the conversation list's status and sort pickers, and
 * the conversation header's menus. Keyboard: arrows move, Home and End jump, Enter picks, Escape
 * closes and returns focus, typing filters when the menu is searchable.
 */
export type MenuItem = {
  value: string;
  label: string;
  icon?: ReactNode;
  /** Shown after the label, quieter (a count, a time). */
  detail?: ReactNode;
  /** A tick: the current choice. */
  checked?: boolean;
  /** Starts a new group (a line above it). */
  divider?: boolean;
  disabled?: boolean;
};

export function Menu({
  button,
  buttonLabel,
  menuLabel,
  items,
  onSelect,
  searchable,
  className,
  iconOnly,
  title,
}: {
  /** What the button shows. */
  button: ReactNode;
  /** The button's accessible name. */
  buttonLabel: string;
  menuLabel: string;
  items: MenuItem[];
  onSelect: (value: string) => void;
  searchable?: boolean;
  className?: string;
  /** No chevron: an icon button that opens a menu. */
  iconOnly?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Placed against the window, so a scrolling or narrow column never clips it.
  const [place, setPlace] = useState<React.CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const shown = items.filter(
    (i) => !query || i.label.toLowerCase().includes(query.toLowerCase()),
  );
  const options = () => [
    ...(panel.current?.querySelectorAll<HTMLButtonElement>(
      "[role^=menuitem]:not(:disabled)",
    ) ?? []),
  ];
  const show = () => {
    const r = trigger.current?.getBoundingClientRect();
    if (r) {
      const end = className?.includes("align-end");
      const below = window.innerHeight - r.bottom;
      setPlace({
        position: "fixed",
        ...(end
          ? { right: Math.max(8, window.innerWidth - r.right) }
          : { left: Math.max(8, r.left) }),
        // Opens upwards when there's little room below.
        ...(below < 260 && r.top > below
          ? { bottom: window.innerHeight - r.top + 4, top: "auto" }
          : { top: r.bottom + 4 }),
      });
    }
    setOpen(true);
  };
  const close = (focus = true) => {
    setOpen(false);
    setQuery("");
    if (focus) trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    // Focus the search, else the current choice, else the first.
    if (searchable)
      panel.current?.querySelector<HTMLInputElement>("input")?.focus();
    else
      (
        options().find((o) => o.getAttribute("aria-checked") === "true") ??
        options()[0]
      )?.focus();
    const outside = (e: MouseEvent) => {
      if (
        !panel.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      )
        close(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const move = (by: number | "first" | "last") => {
    const list = options();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      by === "first"
        ? 0
        : by === "last"
          ? list.length - 1
          : at < 0
            ? by > 0
              ? 0
              : list.length - 1
            : (at + by + list.length) % list.length;
    list[next].focus();
  };
  return (
    <div className={"pg-menu " + (className ?? "")}>
      <button
        ref={trigger}
        type="button"
        className={"pg-menu-button" + (iconOnly ? " icon" : "")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={buttonLabel}
        title={title}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            show();
          }
        }}
      >
        {button}
        {!iconOnly && <ChevronDown size={14} aria-hidden="true" />}
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          role="menu"
          aria-label={menuLabel}
          className="pg-menu-panel"
          style={place}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Home") {
              e.preventDefault();
              move("first");
            } else if (e.key === "End") {
              e.preventDefault();
              move("last");
            } else if (e.key === "Tab") close(false);
          }}
        >
          {searchable && (
            <label className="pg-menu-search">
              <Search size={14} aria-hidden="true" />
              <input
                aria-label={`Search ${menuLabel.toLowerCase()}`}
                placeholder="Search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const first = shown.find((i) => !i.disabled);
                    if (first) {
                      e.preventDefault();
                      close();
                      onSelect(first.value);
                    }
                  }
                }}
              />
            </label>
          )}
          {shown.map((item) => (
            <div key={item.value}>
              {item.divider && !query && (
                <hr className="pg-menu-divider" aria-hidden="true" />
              )}
              <button
                type="button"
                role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={item.checked}
                disabled={item.disabled}
                className="pg-menu-item"
                onClick={() => {
                  close();
                  onSelect(item.value);
                }}
              >
                {item.icon && <span className="pg-menu-icon">{item.icon}</span>}
                <span className="pg-menu-label">{item.label}</span>
                {item.detail !== undefined && (
                  <span className="pg-menu-detail">{item.detail}</span>
                )}
                {item.checked && (
                  <Check
                    size={14}
                    className="pg-menu-check"
                    aria-hidden="true"
                  />
                )}
              </button>
            </div>
          ))}
          {!shown.length && <p className="pg-menu-empty">No matches</p>}
        </div>
      )}
    </div>
  );
}
