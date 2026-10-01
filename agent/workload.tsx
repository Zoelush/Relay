import { useEffect, useRef, useState } from "react";
import { api } from "./api";

type Used = { conversations: number; tickets: number };
type Member = {
  id: string;
  name: string;
  presence: Presence;
  used: Used;
  conversationLimit: number | null;
  ticketLimit: number | null;
};
type Team = {
  id: string;
  name: string;
  version: string;
  method: "manual" | "round_robin" | "balanced";
  conversationLimit: number | null;
  ticketLimit: number | null;
  ticketsCount: boolean;
  includeAway: boolean;
  unassignOnAway: boolean;
  queued: number;
  used: Used;
  members: Member[];
};
type Presence = "active" | "away" | "away_reassigning";
export type Workload = {
  teammateId: string;
  presence: Presence;
  used: Used;
  conversationLimit: number | null;
  ticketLimit: number | null;
  teams: Team[];
  canManage: boolean;
};

const PRESENCE: Record<Presence, string> = {
  active: "Active",
  away: "Away",
  away_reassigning: "Away, reassign replies",
};
/** Plain words for what each method does, because the difference matters. */
export const METHOD_HELP: Record<
  Team["method"],
  { name: string; help: string }
> = {
  manual: {
    name: "Manual",
    help: "Nothing is assigned automatically. Teammates take conversations themselves.",
  },
  round_robin: {
    name: "Round robin",
    help: "Takes turns in order. It ignores how busy anyone is and does not respect assignment limits.",
  },
  balanced: {
    name: "Balanced",
    help: "Gives each conversation to whoever has the fewest open, only within the teammate's and inbox's limits. The rest waits here until someone has room.",
  },
};
const of = (used: number, limit: number | null) =>
  limit === null ? `${used}` : `${used} / ${limit}`;
const message = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;

/** The inbox header's workload controls: your load against your limit, and Next. */
export function WorkloadBar({
  revision,
  onOpen,
}: {
  /** Changes when the workspace changes, to reload. */
  revision: number;
  onOpen: (id: string) => void;
}) {
  const [data, setData] = useState<Workload | null>(null);
  const [panel, setPanel] = useState(false);
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    api<Workload>("workload")
      .then((w) => live && setData(w))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [revision, reload]);
  const next = async () => {
    setNotice("");
    try {
      const r = await api<{ conversationId: string }>("next", {});
      onOpen(r.conversationId);
      setReload((n) => n + 1);
    } catch (e) {
      setNotice(message(e, "Nothing to take right now."));
    }
  };
  // Your status is set in the account menu; going away can change your workload.
  useEffect(() => {
    const changed = () => setReload((n) => n + 1);
    window.addEventListener("relay:presence", changed);
    return () => window.removeEventListener("relay:presence", changed);
  }, []);
  // Shift+N from anywhere outside a text field (the palette dispatches the same event).
  useEffect(() => {
    const onNext = () => void next();
    window.addEventListener("relay:next", onNext);
    return () => window.removeEventListener("relay:next", onNext);
  });
  if (!data) return null;
  return (
    <div className="pg-workload">
      <button
        type="button"
        aria-label={`Your workload: ${data.used.conversations} of ${data.conversationLimit ?? "no limit"}`}
        onClick={() => setPanel(true)}
      >
        Workload {of(data.used.conversations, data.conversationLimit)}
      </button>
      <button type="button" onClick={() => void next()} title="Shift+N">
        Next conversation
      </button>
      {notice && (
        <span role="alert" className="pg-workload-notice">
          {notice}
        </span>
      )}
      {panel && (
        <WorkloadPanel
          data={data}
          onChanged={() => setReload((n) => n + 1)}
          onClose={() => setPanel(false)}
        />
      )}
    </div>
  );
}

/** Your teams: method explained, inbox load against its limit, what is waiting, and each member. */
function WorkloadPanel({
  data,
  onChanged,
  onClose,
}: {
  data: Workload;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<Team | null>(null);
  const first = useRef<HTMLButtonElement>(null);
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
  return (
    <div className="pg-modal-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Workload"
        className="pg-view-dialog pg-workload-panel"
      >
        <header>
          <h2>Workload</h2>
          <button ref={first} type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <p>
          You: {of(data.used.conversations, data.conversationLimit)}{" "}
          conversations
          {data.ticketLimit !== null &&
            `, ${of(data.used.tickets, data.ticketLimit)} tickets`}
        </p>
        {!data.teams.length && (
          <p className="pg-empty">You are not in any team.</p>
        )}
        {data.teams.map((t) => (
          <article key={t.id} aria-label={`Team ${t.name}`} className="pg-team">
            <h3>{t.name}</h3>
            <p className="pg-method">
              <strong>{METHOD_HELP[t.method].name}.</strong>{" "}
              {METHOD_HELP[t.method].help}
            </p>
            <p>
              Inbox:{" "}
              {of(
                t.used.conversations + (t.ticketsCount ? t.used.tickets : 0),
                t.conversationLimit,
              )}{" "}
              open ·{" "}
              <span data-testid={`queued-${t.id}`}>{t.queued} waiting</span>
            </p>
            <table>
              <thead>
                <tr>
                  <th scope="col">Teammate</th>
                  <th scope="col">Status</th>
                  <th scope="col">Open</th>
                </tr>
              </thead>
              <tbody>
                {t.members.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td>{PRESENCE[m.presence]}</td>
                    <td>
                      {of(
                        m.used.conversations + m.used.tickets,
                        m.conversationLimit,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.canManage && (
              <button type="button" onClick={() => setEditing(t)}>
                Edit team settings
              </button>
            )}
          </article>
        ))}
        {editing && (
          <TeamSettings
            team={editing}
            onSaved={() => {
              setEditing(null);
              onChanged();
            }}
            onCancel={() => setEditing(null)}
          />
        )}
      </section>
    </div>
  );
}

/** Method (with what it means), limits, tickets and away options, for managers. */
function TeamSettings({
  team,
  onSaved,
  onCancel,
}: {
  team: Team;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [method, setMethod] = useState(team.method);
  const [limit, setLimit] = useState(
    team.conversationLimit === null ? "" : String(team.conversationLimit),
  );
  const [ticketLimit, setTicketLimit] = useState(
    team.ticketLimit === null ? "" : String(team.ticketLimit),
  );
  const [ticketsCount, setTicketsCount] = useState(team.ticketsCount);
  const [includeAway, setIncludeAway] = useState(team.includeAway);
  const [unassignOnAway, setUnassignOnAway] = useState(team.unassignOnAway);
  const [error, setError] = useState("");
  const save = async () => {
    setError("");
    try {
      await api("teams", {
        id: team.id,
        version: team.version,
        name: team.name,
        method,
        conversationLimit: limit ? Number(limit) : null,
        ticketLimit: ticketLimit ? Number(ticketLimit) : null,
        ticketsCount,
        includeAway,
        unassignOnAway,
      });
      onSaved();
    } catch (e) {
      setError(message(e, "The team could not be saved."));
    }
  };
  return (
    <form
      className="pg-team-settings"
      aria-label={`Settings for ${team.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <fieldset>
        <legend>Assignment method</legend>
        {(Object.keys(METHOD_HELP) as Team["method"][]).map((m) => (
          <label key={m}>
            <input
              type="radio"
              name="method"
              checked={method === m}
              onChange={() => setMethod(m)}
            />
            <span>
              <strong>{METHOD_HELP[m].name}</strong> — {METHOD_HELP[m].help}
            </span>
          </label>
        ))}
      </fieldset>
      <label>
        Inbox limit (open conversations, blank for none)
        <input
          inputMode="numeric"
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
        />
      </label>
      <label>
        Ticket limit (blank for none)
        <input
          inputMode="numeric"
          value={ticketLimit}
          onChange={(e) => setTicketLimit(e.target.value)}
        />
      </label>
      <label className="pg-inline-check">
        <input
          type="checkbox"
          checked={ticketsCount}
          onChange={(e) => setTicketsCount(e.target.checked)}
        />
        Tickets count toward conversation limits
      </label>
      <label className="pg-inline-check">
        <input
          type="checkbox"
          checked={includeAway}
          onChange={(e) => setIncludeAway(e.target.checked)}
        />
        Round robin includes away teammates
      </label>
      <label className="pg-inline-check">
        <input
          type="checkbox"
          checked={unassignOnAway}
          onChange={(e) => setUnassignOnAway(e.target.checked)}
        />
        When a member goes away, return their open conversations to this inbox
      </label>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <footer>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit">Save team</button>
      </footer>
    </form>
  );
}
