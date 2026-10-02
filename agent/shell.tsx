import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { PanelLeftClose, PanelLeftOpen, Pin, PinOff } from "lucide-react";

/**
 * The agent app's frame (docs/AGENT_APP_SHELL.md), after Intercom's: a thin icon strip on the
 * far left that slides out with labels while the mouse is over it (or keyboard focus is in it),
 * and can be pinned open; and beside it each area's own side menu (the inbox's views, the
 * knowledge areas), which can be hidden and then peeks back over the page while the mouse is at
 * the left edge or over its "Show menu" button.
 *
 * Both choices are kept in this browser only. Where storage is blocked they last for the visit.
 */
export const RAIL_KEY = "relay.agent.rail";
export const MENU_KEY = "relay.agent.menu.";
/** Hover delays: a pass across the strip does not open it, and a slip off it does not close it. */
const OPEN_DELAY = 120;
const CLOSE_DELAY = 220;
/** Below this width a side menu starts hidden unless the teammate chose otherwise. */
const NARROW = 1100;

export function readFlag(key: string): boolean | null {
  try {
    const value = window.localStorage.getItem(key);
    return value === "1" ? true : value === "0" ? false : null;
  } catch {
    return null;
  }
}
export function writeFlag(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Storage blocked: the choice lasts for this visit.
  }
}

/** Open after a short hover, close a moment after the mouse leaves; either cancels the other. */
function useHover(onChange: (on: boolean) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  return {
    enter(delay = OPEN_DELAY) {
      clear();
      timer.current = setTimeout(() => onChange(true), delay);
    },
    leave(delay = CLOSE_DELAY) {
      clear();
      timer.current = setTimeout(() => onChange(false), delay);
    },
    now(on: boolean) {
      clear();
      onChange(on);
    },
  };
}

export type RailItem = {
  id: string;
  label: string;
  icon: ReactNode;
  /** Shown beside the label, such as the open count in your inbox. */
  badge?: string;
  /** A fuller accessible name, when the label alone would not say enough. */
  ariaLabel?: string;
  current?: boolean;
  onClick: () => void;
};

function RailButton({ item }: { item: RailItem }) {
  return (
    <button
      type="button"
      className="pg-rail-item"
      aria-current={item.current ? "page" : undefined}
      aria-label={item.ariaLabel}
      onClick={item.onClick}
    >
      <span className="pg-rail-icon" aria-hidden="true">
        {item.icon}
      </span>
      <span className="pg-rail-label">{item.label}</span>
      {item.badge && (
        <span className="pg-rail-badge" aria-hidden={!!item.ariaLabel}>
          {item.badge}
        </span>
      )}
    </button>
  );
}

/**
 * The icon strip. Collapsed it shows icons only (each keeps its name for screen readers); open
 * it lies over the page without moving it; pinned it takes its full width in the layout.
 */
export function Rail({
  items,
  tools,
  account,
}: {
  items: RailItem[];
  tools: RailItem[];
  account: ReactNode;
}) {
  const [pinned, setPinned] = useState(() =>
    typeof window === "undefined" ? false : readFlag(RAIL_KEY) === true,
  );
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const hover = useHover(setHovered);
  const open = pinned || hovered || focused;
  // Using anything in the strip (a destination, the account menu and what is inside it) closes
  // the slid-out strip, so it never covers what was just opened, and keeps it closed until the
  // mouse leaves the strip or Tab moves within it.
  const resting = useRef(false);
  const rest = () => {
    resting.current = true;
    hover.now(false);
    setFocused(false);
  };
  function pin() {
    const next = !pinned;
    setPinned(next);
    writeFlag(RAIL_KEY, next);
    if (!next) hover.now(false);
  }
  return (
    <nav
      className={"pg-rail" + (pinned ? " pinned" : "") + (open ? " open" : "")}
      aria-label="Main"
      data-testid="rail"
      onMouseEnter={() => {
        if (!resting.current) hover.enter();
      }}
      onMouseLeave={() => {
        resting.current = false;
        hover.leave();
      }}
      onClickCapture={(e) => {
        if (!(e.target as Element).closest(".pg-rail-pin")) rest();
      }}
      onFocus={(e) => {
        // Keyboard focus opens it; a click (which also focuses) is left to the hover.
        if (
          !resting.current &&
          (e.target as HTMLElement).matches(":focus-visible")
        )
          setFocused(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setFocused(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Tab") resting.current = false;
        if (e.key === "Escape" && !pinned && (hovered || focused)) {
          hover.now(false);
          setFocused(false);
        }
      }}
    >
      <div className="pg-rail-panel">
        <div className="pg-rail-head">
          <span className="pg-brand">
            <span aria-hidden="true">◈</span>{" "}
            <strong className="pg-rail-label">Relay</strong>
          </span>
          <button
            type="button"
            className="pg-rail-pin"
            aria-label={pinned ? "Unpin navigation" : "Pin navigation"}
            aria-pressed={pinned}
            title={pinned ? "Unpin navigation" : "Pin navigation open"}
            onClick={pin}
          >
            {pinned ? (
              <PinOff size={15} aria-hidden="true" />
            ) : (
              <Pin size={15} aria-hidden="true" />
            )}
          </button>
        </div>
        <div className="pg-rail-items">
          {items.map((item) => (
            <RailButton key={item.id} item={item} />
          ))}
        </div>
        <div className="pg-rail-foot">
          {tools.map((item) => (
            <RailButton key={item.id} item={item} />
          ))}
          {account}
        </div>
      </div>
    </nav>
  );
}

export type SideMenuState = {
  hidden: boolean;
  peek: boolean;
  setHidden: (hidden: boolean) => void;
  hover: ReturnType<typeof useHover>;
};

/** A side menu's hidden choice (per area) and its peek while hidden. */
export function useSideMenu(area: string): SideMenuState {
  const key = MENU_KEY + area;
  const [hidden, setHiddenState] = useState(() => {
    if (typeof window === "undefined") return false;
    const saved = readFlag(key);
    return saved ?? window.innerWidth < NARROW;
  });
  const [peek, setPeek] = useState(false);
  const hover = useHover(setPeek);
  const setHidden = useCallback(
    (value: boolean) => {
      setHiddenState(value);
      writeFlag(key, value);
      setPeek(false);
    },
    [key],
  );
  return { hidden, peek, setHidden, hover };
}

/**
 * An area's side menu. Hidden, it leaves a thin edge that, like its "Show menu" button, brings
 * it back over the page while the mouse is there; Escape or moving away puts it away again.
 */
export function SideMenu({
  state,
  title,
  label,
  actions,
  footer,
  children,
}: {
  state: SideMenuState;
  title: string;
  /** The menu's accessible name. */
  label: string;
  /** Buttons beside the title, such as "Create view". */
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { hidden, peek, setHidden, hover } = state;
  const shown = !hidden || peek;
  return (
    // Hover is tracked on the slot, which holds both the edge and the menu, so moving from one
    // to the other keeps the peek and leaving both ends it.
    <div
      className={
        "pg-sidemenu-slot" + (hidden ? " hidden" : "") + (peek ? " peek" : "")
      }
      onMouseEnter={() => hidden && hover.enter(peek ? 0 : undefined)}
      onMouseLeave={() => hidden && hover.leave()}
    >
      {hidden && (
        <div
          className="pg-sidemenu-edge"
          aria-hidden="true"
          data-testid={`${label} edge`}
        />
      )}
      <aside
        className="pg-sidemenu"
        aria-label={label}
        hidden={!shown}
        onKeyDown={(e) => {
          if (e.key === "Escape" && peek) hover.now(false);
        }}
      >
        <header className="pg-sidemenu-head">
          <h1>{title}</h1>
          {actions}
          <button
            type="button"
            className="pg-sidemenu-toggle"
            aria-label={hidden ? "Keep menu open" : "Hide menu"}
            title={hidden ? "Keep menu open" : "Hide menu"}
            onClick={() => setHidden(!hidden)}
          >
            {hidden ? (
              <PanelLeftOpen size={16} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={16} aria-hidden="true" />
            )}
          </button>
        </header>
        <div className="pg-sidemenu-body">{children}</div>
        {footer && <footer className="pg-sidemenu-foot">{footer}</footer>}
      </aside>
    </div>
  );
}

/** "Show menu" for the column beside a hidden side menu: hover peeks, a click keeps it open. */
export function ShowMenuButton({ state }: { state: SideMenuState }) {
  if (!state.hidden) return null;
  return (
    <button
      type="button"
      className="pg-sidemenu-toggle"
      aria-label="Show menu"
      title="Show menu"
      onMouseEnter={() => state.hover.enter()}
      onMouseLeave={() => state.hover.leave()}
      onClick={() => state.setHidden(false)}
    >
      <PanelLeftOpen size={16} aria-hidden="true" />
    </button>
  );
}

/** The top of a list column: the menu button when its menu is hidden, the title, and extras. */
export function ListHeader({
  menu,
  title,
  level = 2,
  children,
}: {
  menu?: SideMenuState;
  title: string;
  level?: 1 | 2;
  children?: ReactNode;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <header className="pg-list-head">
      {menu && <ShowMenuButton state={menu} />}
      <Heading title={title}>{title}</Heading>
      {children}
    </header>
  );
}
