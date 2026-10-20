import { useCallback, useEffect, useState } from "react";
import { Activity, AlarmClock, Hourglass, Inbox, Moon, RefreshCw, TriangleAlert, UserX } from "lucide-react";
import { api } from "./api";
import { message } from "./settings-ui";
import { channelLabel } from "../lib/channels";
import type { LiveDashboard } from "../server/live";

/**
 * The live dashboard (phase 14, step R4; docs/REPORTING_STEP4.md), at `#reports/live` and from the
 * inbox's menu: what's happening now. It asks `live-dashboard` every 15 seconds while the tab is
 * visible (and at once on coming back to it); waits tick on between answers. Every number is the
 * server's; the page only counts on the seconds since it was asked.
 */
const EVERY_MS = 15_000;
type Directory = { teammates: { id: string; name: string }[]; teams: { id: string; name: string }[] };
const PRESENCE: Record<string, string> = { active: "Active", away: "Away", away_reassigning: "Away, reassigning" };

function fmtWait(ms: number | null) {
  if (ms === null) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400),
    h = Math.floor((s % 86_400) / 3600),
    m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function LivePage({ menu, directory, onConversation }: { menu: React.ReactNode; directory: Directory; onConversation?: (id: string) => void }) {
  const [team, setTeam] = useState("");
  const [answer, setAnswer] = useState<{ data: LiveDashboard; at: number } | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const load = useCallback(
    () =>
      api<LiveDashboard>("live-dashboard" + (team ? "?team=" + encodeURIComponent(team) : ""))
        .then((data) => {
          setAnswer({ data, at: Date.now() });
          setError("");
        })
        .catch((e) => setError(message(e, "The dashboard couldn't be refreshed."))),
    [team],
  );
  // Asked now, then every 15 seconds while the tab is visible, and at once on coming back to it.
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  const since = answer ? now - answer.at : 0;
  const d = answer?.data;
  const teamName = (id: string | null) => (id ? (directory.teams.find((t) => t.id === id)?.name ?? id) : "No team");
  const person = (id: string | null) => (id ? (directory.teammates.find((t) => t.id === id)?.name ?? id) : "Unassigned");
  const tiles: { id: string; label: string; value: string; icon: React.ReactNode; hue: string; tone?: "bad" | "warn" }[] = d
    ? [
        { id: "open", label: "Open now", value: String(d.totals.open), icon: <Inbox size={15} />, hue: "violet" },
        { id: "unassigned", label: "Unassigned", value: String(d.totals.unassigned), icon: <UserX size={15} />, hue: "blue", tone: d.totals.unassigned ? "warn" : undefined },
        { id: "waiting", label: "Waiting for a reply", value: String(d.totals.waiting), icon: <Hourglass size={15} />, hue: "teal" },
        { id: "longest", label: "Longest wait", value: fmtWait(d.totals.longestWaitMs === null ? null : d.totals.longestWaitMs + since), icon: <AlarmClock size={15} />, hue: "amber" },
        { id: "breached", label: "SLA missed", value: String(d.totals.breached), icon: <TriangleAlert size={15} />, hue: "rose", tone: d.totals.breached ? "bad" : undefined },
        { id: "risk", label: "SLA due within 1h", value: String(d.totals.atRisk), icon: <AlarmClock size={15} />, hue: "amber", tone: d.totals.atRisk ? "warn" : undefined },
        { id: "snoozed", label: "Snoozed", value: String(d.totals.snoozed), icon: <Moon size={15} />, hue: "slate" },
      ]
    : [];
  return (
    <>
      <header className="pg-rep-head">
        <div className="pg-rep-title">
          {menu}
          <div>
            <h2>
              Live{" "}
              <span className="pg-live-badge" data-stale={error ? "true" : undefined}>
                <span className="pg-live-dot" aria-hidden="true" />
                {error ? "Not updating" : answer ? `Updated ${since < 5000 ? "just now" : fmtWait(since) + " ago"}` : "Connecting"}
              </span>
            </h2>
            <p className="pg-muted">What&rsquo;s happening now: the queue, who&rsquo;s waiting, your team and your SLAs. Refreshed every 15 seconds while this tab is open.</p>
          </div>
        </div>
        <div className="pg-rep-toolbar" role="toolbar" aria-label="Live dashboard">
          <select aria-label="Team" value={team} onChange={(e) => setTeam(e.target.value)}>
            <option value="">All teams</option>
            {directory.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button type="button" className="pg-wf-link pg-live-refresh" onClick={() => void load()}>
            <RefreshCw size={13} aria-hidden="true" /> Refresh now
          </button>
          {error && (
            <span role="alert" className="pg-attr-error">
              {error}
            </span>
          )}
        </div>
      </header>
      <div className="pg-rep-body">
        {!d ? (
          <div className="pg-rep-tiles">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="pg-rep-tile">
                <div className="pg-rep-skeleton" aria-busy="true" />
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="pg-rep-tiles pg-live-tiles">
              {tiles.map((t) => (
                <section key={t.id} className="pg-rep-tile" data-hue={t.hue} data-tone={t.tone} aria-label={t.label}>
                  <header>
                    <span className="pg-live-icon" aria-hidden="true">
                      {t.icon}
                    </span>
                    <h3>{t.label}</h3>
                  </header>
                  <p className="pg-rep-value" data-testid="value">
                    {t.value}
                  </p>
                </section>
              ))}
            </div>
            <div className="pg-rep-grid">
              <section className="pg-rep-card" data-hue="amber" aria-label="Waiting longest">
                <header>
                  <h3>
                    Waiting longest <span className="pg-muted">for a teammate&rsquo;s reply</span>
                  </h3>
                </header>
                {d.waitingLongest.length ? (
                  <ol className="pg-live-queue">
                    {d.waitingLongest.map((c) => (
                      <li key={c.id}>
                        <button type="button" onClick={() => onConversation?.(c.id)} disabled={!onConversation}>
                          <span className="pg-live-wait" data-sla={c.sla ?? undefined}>
                            {fmtWait(c.waitingMs + since)}
                          </span>
                          <span className="pg-live-what">
                            <strong>{c.title || "Untitled conversation"}</strong>
                            <span className="pg-muted">
                              {channelLabel(c.channel)} · {teamName(c.teamId)} · {person(c.assigned)}
                            </span>
                          </span>
                          {c.sla && <span className="pg-live-sla" data-sla={c.sla}>{c.sla === "breached" ? "SLA missed" : "SLA soon"}</span>}
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="pg-rep-empty">Nobody is waiting for a reply.</p>
                )}
              </section>
              <section className="pg-rep-card" data-hue="teal" aria-label="Teammates">
                <header>
                  <h3>
                    Teammates <span className="pg-muted">{d.teammates.filter((p) => p.presence === "active").length} active of {d.teammates.length}</span>
                  </h3>
                </header>
                <ul className="pg-live-people">
                  {[...d.teammates]
                    .sort((a, b) => Number(b.presence === "active") - Number(a.presence === "active") || b.open - a.open)
                    .map((p) => (
                      <li key={p.id} aria-label={p.name}>
                        <span className="pg-live-avatar" data-presence={p.presence} aria-hidden="true">
                          {p.name.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="pg-live-who">
                          <strong>{p.name}</strong>
                          <span className="pg-muted" data-testid="presence">
                            {PRESENCE[p.presence] ?? p.presence}
                            {p.since ? ` · since ${new Date(p.since).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : ""}
                          </span>
                        </span>
                        <span className="pg-live-load" title={p.limit ? `${p.open} of a limit of ${p.limit}` : `${p.open} open`}>
                          <span className="pg-rep-bar-track" aria-hidden="true">
                            <span style={{ width: `${p.limit ? Math.min(100, (p.open / p.limit) * 100) : Math.min(100, p.open * 10)}%` }} data-full={p.limit && p.open >= p.limit ? "true" : undefined} />
                          </span>
                          <span className="pg-live-count" data-testid="load">
                            {p.open}
                            {p.limit ? <small>/{p.limit}</small> : null} open
                          </span>
                        </span>
                      </li>
                    ))}
                </ul>
              </section>
              <section className="pg-rep-card wide" data-hue="violet" aria-label="Queue by team">
                <header>
                  <h3>Queue by team</h3>
                </header>
                <table className="pg-email-records pg-people-table pg-live-teams">
                  <thead>
                    <tr>
                      <th scope="col">Team</th>
                      <th scope="col">Open</th>
                      <th scope="col">Unassigned</th>
                      <th scope="col">Waiting</th>
                      <th scope="col">Longest wait</th>
                      <th scope="col">SLA due soon</th>
                      <th scope="col">SLA missed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.teams.map((t) => (
                      <tr key={t.id ?? "none"}>
                        <th scope="row">{t.name}</th>
                        <td>{t.open}</td>
                        <td>{t.unassigned}</td>
                        <td>{t.waiting}</td>
                        <td>{fmtWait(t.longestWaitMs === null ? null : t.longestWaitMs + since)}</td>
                        <td data-tone={t.atRisk ? "warn" : undefined}>{t.atRisk}</td>
                        <td data-tone={t.breached ? "bad" : undefined}>{t.breached}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </div>
          </>
        )}
      </div>
    </>
  );
}
export const LiveIcon = Activity;
