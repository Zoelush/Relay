import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › Security › Audit log (phase 16, step C1; docs/SECURITY_STEP1.md), behind
 * `security_v1`, for who manages the workspace. Every administrative and sensitive action, newest
 * first: filtered by time, area, teammate and what it was done to; exported as CSV or JSON (a job,
 * itself audited); kept for the retention chosen here. Nothing here can change or remove an event.
 */
type Event = {
  id: string;
  at: string;
  action: string;
  label: string;
  area: string;
  actor: { type: "teammate" | "system"; id?: string; name: string };
  via: string | null;
  target: { type: string; id: string | null; name: string | null };
  details: Record<string, unknown>;
};
type Export = { id: string; format: string; status: "preparing" | "done" | "failed"; rows: number; createdAt: string; url: string | null };
type Data = { events: Event[]; next: string | null; areas: string[]; teammates: { id: string; name: string }[]; retentionDays: number; exports: Export[] };
type Filters = { from: string; to: string; area: string; actor: string; q: string };
const NONE: Filters = { from: "", to: "", area: "", actor: "", q: "" };
const RETENTION = [
  [90, "90 days"],
  [180, "6 months"],
  [365, "1 year"],
  [730, "2 years"],
  [1095, "3 years"],
  [2555, "7 years"],
] as const;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
/** Filters as the server reads them (dates are the local day's start, and the day after the "to" day). */
const query = (f: Filters) => {
  const q: Record<string, string> = {};
  if (f.from) q.from = new Date(f.from + "T00:00").toISOString();
  if (f.to) q.to = new Date(new Date(f.to + "T00:00").getTime() + 86_400_000).toISOString();
  if (f.area) q.area = f.area;
  if (f.actor) q.actor = f.actor;
  if (f.q.trim()) q.q = f.q.trim();
  return q;
};
const via = (v: string | null) => (!v ? "" : v.startsWith("app:") ? " via an app" : v.startsWith("api_token:") ? " via an API token" : "");

/** A change's details in words: "from → to", the keys changed, or what was recorded. */
function Details({ details }: { details: Record<string, unknown> }) {
  const entries = Object.entries(details);
  if (!entries.length) return null;
  const show = (v: unknown) => (v === null || v === undefined ? "nothing" : typeof v === "string" ? v : JSON.stringify(v));
  return (
    <ul className="pg-audit-details">
      {entries.map(([k, v]) => {
        const c = v as { from?: unknown; to?: unknown; keys?: string[]; changed?: boolean } | null;
        return (
          <li key={k}>
            <code>{k}</code>{" "}
            {c && typeof c === "object" && "from" in c
              ? `${show(c.from)} → ${show(c.to)}`
              : c && typeof c === "object" && Array.isArray(c.keys)
                ? `changed: ${c.keys.join(", ") || "—"}`
                : c && typeof c === "object" && c.changed
                  ? "changed"
                  : show(v)}
          </li>
        );
      })}
    </ul>
  );
}

export function AuditPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Data | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [filters, setFilters] = useState<Filters>(NONE);
  const [applied, setApplied] = useState<Filters>(NONE);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(
    (f: Filters, before?: string) =>
      api<Data>("audit?" + new URLSearchParams({ ...query(f), ...(before ? { before } : {}) }))
        .then((d) => {
          setData(d);
          setEvents((now) => (before ? [...now, ...d.events] : d.events));
          setError("");
        })
        .catch((e) => setError(message(e, "The audit log couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load(applied);
  }, [load, applied]);
  const change = async (p: Record<string, unknown>, fallback: string) => {
    try {
      await api("audit", p);
      await load(applied);
    } catch (e) {
      setError(message(e, fallback));
    }
  };
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setFilters({ ...filters, [k]: e.target.value });
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <Card title="Activity" description="Every administrative and sensitive action, with who did it and when. Events can't be changed or removed here: only retention removes them.">
        <form
          className="pg-audit-filters"
          aria-label="Filter the audit log"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(filters);
          }}
        >
          <label>
            <span>From</span>
            <input type="date" value={filters.from} onChange={set("from")} />
          </label>
          <label>
            <span>To</span>
            <input type="date" value={filters.to} onChange={set("to")} />
          </label>
          <label>
            <span>Area</span>
            <select value={filters.area} onChange={set("area")}>
              <option value="">All areas</option>
              {data?.areas.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Who</span>
            <select value={filters.actor} onChange={set("actor")}>
              <option value="">Anyone</option>
              <option value="system">Relay (automatic)</option>
              {data?.teammates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="pg-audit-search">
            <span>Search</span>
            <input type="search" value={filters.q} placeholder="A name, id or teammate" onChange={set("q")} />
          </label>
          <button type="submit" className="pg-primary">
            Filter
          </button>
          {JSON.stringify(applied) !== JSON.stringify(NONE) && (
            <button
              type="button"
              className="pg-wf-link"
              onClick={() => {
                setFilters(NONE);
                setApplied(NONE);
              }}
            >
              Clear
            </button>
          )}
          <button type="button" className="pg-wf-link" onClick={() => void load(applied)}>
            <RefreshCw size={12} aria-hidden="true" /> Refresh
          </button>
        </form>
        {data && !events.length && <p className="pg-muted">Nothing recorded{JSON.stringify(applied) !== JSON.stringify(NONE) ? " that matches" : " yet"}.</p>}
        {events.length > 0 && (
          <table className="pg-email-records pg-people-table pg-audit-table" aria-label="Audit log">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
                <th scope="col">On</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>
                    <time dateTime={e.at}>{when(e.at)}</time>
                  </td>
                  <td>
                    {e.actor.name}
                    <span className="pg-muted">{via(e.via)}</span>
                  </td>
                  <th scope="row">
                    {Object.keys(e.details).length ? (
                      <button type="button" className="pg-wf-link" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
                        {e.label}
                      </button>
                    ) : (
                      e.label
                    )}
                    <small className="pg-muted pg-audit-area">{e.area}</small>
                    {open === e.id && <Details details={e.details} />}
                  </th>
                  <td>
                    {e.target.name ?? e.target.id ?? <span className="pg-muted">{e.target.type}</span>}
                    {e.target.name && e.target.id && e.target.name !== e.target.id && <small className="pg-muted pg-audit-area">{e.target.id}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data?.next && (
          <button type="button" className="pg-wf-link" onClick={() => void load(applied, data.next!)}>
            Older events
          </button>
        )}
      </Card>
      {data && (
        <Card title="Export" description="Everything the filters above match, oldest first. Exports are prepared in the background and recorded in this log.">
          <div className="pg-webhook-actions">
            <button type="button" className="pg-wf-link" onClick={() => void change({ action: "export", format: "csv", filters: query(applied) }, "The export couldn't be started.")}>
              <Download size={12} aria-hidden="true" /> Export CSV
            </button>
            <button type="button" className="pg-wf-link" onClick={() => void change({ action: "export", format: "json", filters: query(applied) }, "The export couldn't be started.")}>
              <Download size={12} aria-hidden="true" /> Export JSON
            </button>
          </div>
          {data.exports.length > 0 && (
            <ul className="pg-audit-exports" aria-label="Your exports">
              {data.exports.map((x) => (
                <li key={x.id}>
                  {x.format.toUpperCase()} · {when(x.createdAt)} ·{" "}
                  {x.status === "done" && x.url ? (
                    <a href={x.url} download>
                      Download ({x.rows} event{x.rows === 1 ? "" : "s"})
                    </a>
                  ) : x.status === "failed" ? (
                    <span className="pg-attr-error">failed</span>
                  ) : (
                    <span className="pg-muted">preparing…</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {data && (
        <Card title="Retention" description="How long events are kept. Older events are removed automatically; changing this is recorded.">
          <label className="pg-settings-field">
            <span className="pg-settings-label">Keep events for</span>
            <select value={data.retentionDays} onChange={(e) => void change({ action: "retention", retentionDays: Number(e.target.value) }, "Retention couldn't be changed.")}>
              {RETENTION.map(([d, label]) => (
                <option key={d} value={d}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </Card>
      )}
    </Frame>
  );
}
