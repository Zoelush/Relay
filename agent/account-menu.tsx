import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Building2,
  Check,
  LogOut,
  Monitor,
  Moon,
  Repeat,
  Sun,
  UserRound,
} from "lucide-react";
import { api } from "./api";
import type { Workload } from "./workload";
import type { ThemeChoice } from "./theme";

/**
 * The account menu in the sidebar's lower corner (agent dark mode follow-up): who you are, your
 * status (away, and whether your replies are reassigned while away), the theme, the workspace,
 * your profile, and signing out where the hosting sign-in supports it.
 *
 * Status uses phase 06 presence; when routing is off for the workspace there is no status to set,
 * and the switches are not shown.
 * TODO(phase 16): editing your profile, and workspace settings, with teammate administration.
 * TODO(phase 17): creating a new workspace, with onboarding.
 */
type Presence = Workload["presence"];
export type Account = {
  name: string;
  role: string;
  workspace: { id: string; name: string };
  /** From the hosting sign-in, where it gives one. */
  email?: string;
  /** Where signing out goes, where the hosting sign-in supports it. */
  signOutHref?: string;
};

/** Role names are stored as written by admins ("owner"); shown with a capital. */
const roleName = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]?.toUpperCase() ?? "")
    .join("") || "?";
const PRESENCE_WORDS: Record<Presence, string> = {
  active: "Active",
  away: "Away",
  away_reassigning: "Away, replies reassigned",
};
const THEMES: [ThemeChoice, string, typeof Sun][] = [
  ["system", "System", Monitor],
  ["light", "Light", Sun],
  ["dark", "Dark", Moon],
];
/** Announces a presence change, so the workload bar reloads. */
export const PRESENCE_EVENT = "relay:presence";

export function AccountMenu({
  account,
  theme,
  onTheme,
}: {
  account: Account;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState(false);
  const [workload, setWorkload] = useState<Workload | null>(null);
  const [problem, setProblem] = useState("");
  const [saving, setSaving] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const load = useCallback(
    () =>
      api<Workload>("workload")
        .then(setWorkload)
        // Routing off: there is no status to show.
        .catch(() => setWorkload(null)),
    [],
  );
  useEffect(() => {
    void load();
    window.addEventListener(PRESENCE_EVENT, load);
    return () => window.removeEventListener(PRESENCE_EVENT, load);
  }, [load]);
  const close = useCallback((focusButton = true) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  }, []);
  // Opening moves focus into the menu; a click outside closes it.
  useEffect(() => {
    if (!open) return;
    panel.current
      ?.querySelector<HTMLElement>("button:not(:disabled), a")
      ?.focus();
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target))
        close(false);
    };
    // Escape closes it wherever focus is (a refused change can leave focus outside it).
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, close]);

  const presence = workload?.presence;
  const away = presence === "away" || presence === "away_reassigning";
  async function setPresence(next: Presence) {
    if (!workload || saving) return;
    const before = workload;
    setProblem("");
    setSaving(true);
    // Shown at once; put back if the change is refused.
    setWorkload({ ...workload, presence: next });
    try {
      await api("presence", { presence: next });
      window.dispatchEvent(new Event(PRESENCE_EVENT));
    } catch (e) {
      setWorkload(before);
      setProblem(
        e instanceof Error ? e.message : "Your status could not be changed.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pg-account">
      <button
        ref={button}
        type="button"
        className="pg-account-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Account: ${account.name}${presence ? ", " + PRESENCE_WORDS[presence] : ""}`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Avatar name={account.name} presence={presence} />
        <span className="pg-account-name">{account.name}</span>
      </button>
      {open && (
        <div
          ref={panel}
          id={panelId}
          role="dialog"
          aria-label="Account"
          className="pg-account-menu"
          aria-busy={saving}
        >
          <header className="pg-account-head">
            <Avatar name={account.name} presence={presence} large />
            <div>
              <strong>{account.name}</strong>
              {account.email && <span>{account.email}</span>}
              <span>
                {roleName(account.role)}
                {presence ? ` · ${PRESENCE_WORDS[presence]}` : ""}
              </span>
            </div>
          </header>
          {workload && (
            <section className="pg-account-section" aria-label="Status">
              <Switch
                label="Away"
                icon={<Moon size={16} aria-hidden="true" />}
                checked={away}
                onChange={(on) => void setPresence(on ? "away" : "active")}
              />
              <Switch
                label="Reassign replies"
                hint="While you're away, a customer's reply to one of your conversations sends it back to its team inbox."
                icon={<Repeat size={16} aria-hidden="true" />}
                checked={presence === "away_reassigning"}
                disabled={!away}
                onChange={(on) =>
                  void setPresence(on ? "away_reassigning" : "away")
                }
              />
              {problem && (
                <p role="alert" className="pg-account-problem">
                  {problem}
                </p>
              )}
            </section>
          )}
          <section className="pg-account-section" aria-label="Workspace">
            <h3>Workspace</h3>
            <p className="pg-account-item" aria-current="true">
              <Building2 size={16} aria-hidden="true" />
              <span>{account.workspace.name}</span>
              <Check size={16} aria-label="Current workspace" />
            </p>
            <button
              type="button"
              className="pg-account-item"
              onClick={() => {
                close(false);
                setProfile(true);
              }}
            >
              <UserRound size={16} aria-hidden="true" />
              <span>Your profile</span>
            </button>
          </section>
          <section className="pg-account-section" aria-label="Theme">
            <h3>Theme</h3>
            <div className="pg-theme" role="group" aria-label="Theme">
              {THEMES.map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={theme === value}
                  onClick={() => onTheme(value)}
                >
                  <Icon size={14} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </section>
          {account.signOutHref && (
            <section className="pg-account-section">
              <a
                className="pg-account-item pg-account-out"
                href={account.signOutHref}
              >
                <LogOut size={16} aria-hidden="true" />
                <span>Sign out</span>
              </a>
            </section>
          )}
        </div>
      )}
      {profile && (
        <Profile
          account={account}
          workload={workload}
          onClose={() => {
            setProfile(false);
            button.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function Avatar({
  name,
  presence,
  large,
}: {
  name: string;
  presence?: Presence;
  large?: boolean;
}) {
  return (
    <span
      className={"pg-account-avatar" + (large ? " large" : "")}
      aria-hidden="true"
    >
      {initials(name)}
      {presence && (
        <i
          className={
            "pg-presence-dot " + (presence === "active" ? "active" : "away")
          }
        />
      )}
    </span>
  );
}

function Switch({
  label,
  hint,
  icon,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  icon: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  const labelId = useId(),
    hintId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={hint ? hintId : undefined}
      disabled={disabled}
      className="pg-account-item pg-switch"
      onClick={() => onChange(!checked)}
    >
      {icon}
      <span>
        <span id={labelId}>{label}</span>
        {hint && (
          <small id={hintId} className="pg-account-hint">
            {hint}
          </small>
        )}
      </span>
      <i className="pg-switch-track" aria-hidden="true" />
    </button>
  );
}

/** Your profile, read only: what Relay knows about you here. */
function Profile({
  account,
  workload,
  onClose,
}: {
  account: Account;
  workload: Workload | null;
  onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => closeButton.current?.focus(), []);
  const limit = (used: number, max: number | null) =>
    max === null ? `${used} open, no limit` : `${used} of ${max}`;
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
        aria-label="Your profile"
        className="pg-dialog pg-profile"
      >
        <header className="pg-account-head">
          <Avatar name={account.name} presence={workload?.presence} large />
          <div>
            <h2>{account.name}</h2>
            {account.email && <span>{account.email}</span>}
          </div>
        </header>
        <dl>
          <dt>Role</dt>
          <dd>{roleName(account.role)}</dd>
          <dt>Workspace</dt>
          <dd>{account.workspace.name}</dd>
          {workload && (
            <>
              <dt>Status</dt>
              <dd>{PRESENCE_WORDS[workload.presence]}</dd>
              <dt>Teams</dt>
              <dd>{workload.teams.map((t) => t.name).join(", ") || "None"}</dd>
              <dt>Conversations</dt>
              <dd>
                {limit(workload.used.conversations, workload.conversationLimit)}
              </dd>
              <dt>Tickets</dt>
              <dd>{limit(workload.used.tickets, workload.ticketLimit)}</dd>
            </>
          )}
        </dl>
        <p className="pg-muted">
          Your name and email come from your sign-in. An admin manages your
          role, teams and limits.
        </p>
        <footer>
          <button ref={closeButton} type="button" onClick={onClose}>
            Close
          </button>
        </footer>
      </section>
    </div>
  );
}
