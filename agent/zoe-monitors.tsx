import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "./api";
import type { SideMenuState } from "./shell";
import { Card, Field, Frame, message, type Page } from "./settings-ui";
import { ago } from "./zoe-labels";
import {
  SENSITIVITY,
  changeSentence,
  monitorOf,
  percent,
  type Sensitivity,
} from "../lib/zoe-monitors";

/**
 * Analyze › Monitors and Analyze › Incidents (phase 08, step C2b; docs/AI_STEP12.md), while
 * `zoe_monitors_v1` is on. The server checks each monitor hourly and opens incidents; these pages
 * show the numbers it computed, change a monitor's setting, and acknowledge or resolve incidents.
 */
type Monitor = {
  metric: string;
  enabled: boolean;
  sensitivity: Sensitivity;
  version: string;
  current: number | null;
  baseline: number | null;
  volume: number;
  baselineVolume: number;
  status: "normal" | "tripped" | "low_volume" | "off";
  incidentId: string | null;
};
type MonitorsData = { lastCheckedAt: string | null; monitors: Monitor[]; alerts: { email: boolean; addresses: string[] } };

const STATUS_NAMES: Record<Monitor["status"], [string, string]> = {
  normal: ["Normal", "green"],
  tripped: ["Changed sharply", "rose"],
  low_volume: ["Not enough answers yet", "slate"],
  off: ["Off", "slate"],
};

export function MonitorsPage({
  menu,
  page,
  onIncidents,
}: {
  menu: SideMenuState;
  page: Page;
  onIncidents: () => void;
}) {
  const [data, setData] = useState<MonitorsData | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () =>
    api<MonitorsData>("zoe?view=monitors")
      .then(setData)
      .catch((e) => setError(message(e, "This page could not be loaded.")));
  useEffect(() => {
    void load();
  }, []);
  async function save(m: Monitor, enabled: boolean, sensitivity: Sensitivity) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      setData(
        await api<MonitorsData>("zoe-monitors", {
          action: "monitor",
          metric: m.metric,
          enabled,
          sensitivity,
          version: m.version,
        }),
      );
      setStatus(`${monitorOf(m.metric)?.name} saved.`);
    } catch (e) {
      setError(message(e, "The monitor could not be saved."));
      void load();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <p role="status" className="pg-muted pg-zoe-review-status">
        {status}
      </p>
      {data && (
        <>
          <p className="pg-muted">
            {data.lastCheckedAt ? `Last checked ${ago(data.lastCheckedAt)}.` : "Not checked yet."}
          </p>
          <ul className="pg-zoe-monitors" aria-label="Monitors">
            {data.monitors.map((m) => (
              <MonitorRow key={m.metric + m.version} m={m} busy={busy} onSave={save} onIncidents={onIncidents} />
            ))}
          </ul>
          {data.alerts.email && (
            <AlertAddresses
              key={data.alerts.addresses.join(",")}
              addresses={data.alerts.addresses}
              onSave={async (addresses) => {
                setError("");
                setStatus("");
                try {
                  setData(await api<MonitorsData>("zoe-monitors", { action: "alerts", addresses }));
                  setStatus(addresses.length ? "Incidents will be emailed too." : "Incidents are shown in the app only.");
                } catch (e) {
                  setError(message(e, "The addresses could not be saved."));
                }
              }}
            />
          )}
        </>
      )}
    </Frame>
  );
}

/** Phase 12 E4: where incidents are emailed, besides the app's notifications (up to five addresses). */
function AlertAddresses({ addresses, onSave }: { addresses: string[]; onSave: (addresses: string[]) => Promise<void> }) {
  const [value, setValue] = useState(addresses.join(", "));
  return (
    <Card title="Email alerts" description="Each new incident is emailed to these addresses as well as shown here. Up to five; leave empty for the app only.">
      <form
        className="pg-settings-row"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(value.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean));
        }}
      >
        <Field label="Email incidents to">{(id) => <input id={id} value={value} placeholder="ops@yourcompany.com" onChange={(e) => setValue(e.target.value)} />}</Field>
        <button type="submit" className="pg-zoe-secondary">
          Save addresses
        </button>
      </form>
    </Card>
  );
}

function MonitorRow({
  m,
  busy,
  onSave,
  onIncidents,
}: {
  m: Monitor;
  busy: boolean;
  onSave: (m: Monitor, enabled: boolean, sensitivity: Sensitivity) => Promise<void>;
  onIncidents: () => void;
}) {
  const def = monitorOf(m.metric)!;
  const [enabled, setEnabled] = useState(m.enabled);
  const [sensitivity, setSensitivity] = useState(m.sensitivity);
  const dirty = enabled !== m.enabled || sensitivity !== m.sensitivity;
  const [label, hue] = m.incidentId ? ["Incident open", "rose"] : STATUS_NAMES[m.status];
  return (
    <li className="pg-zoe-monitor" aria-label={def.name}>
      <header>
        <strong>{def.name}</strong>
        <span className="pg-zoe-review-why" data-hue={hue}>
          {label}
        </span>
      </header>
      <p className="pg-muted">{def.description}</p>
      <dl className="pg-zoe-monitor-numbers">
        <div>
          <dt>Last 24 hours</dt>
          <dd>
            {percent(m.current)} <small className="pg-muted">of {m.volume}</small>
          </dd>
        </div>
        <div>
          <dt>Usual (7 days before)</dt>
          <dd>
            {percent(m.baseline)} <small className="pg-muted">of {m.baselineVolume}</small>
          </dd>
        </div>
      </dl>
      {m.status === "low_volume" && (
        <p className="pg-muted">
          It needs at least {def.min} in the last 24 hours and in the 7 days before to compare.
        </p>
      )}
      <form
        className="pg-zoe-monitor-form"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(m, enabled, sensitivity);
        }}
      >
        <label className="pg-settings-inline">
          <input
            type="checkbox"
            role="switch"
            aria-checked={enabled}
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          On
        </label>
        <label className="pg-settings-inline">
          Sensitivity
          <select
            value={sensitivity}
            disabled={!enabled}
            onChange={(e) => setSensitivity(e.target.value as Sensitivity)}
          >
            {(Object.keys(SENSITIVITY) as Sensitivity[]).map((s) => (
              <option key={s} value={s}>
                {SENSITIVITY[s].name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="pg-zoe-secondary" disabled={busy || !dirty}>
          Save
        </button>
        {m.incidentId && (
          <button type="button" className="pg-link-button" onClick={onIncidents}>
            View the incident
          </button>
        )}
      </form>
    </li>
  );
}

type Incident = {
  id: string;
  metric: string;
  status: "open" | "acknowledged" | "resolved";
  openedAt: string;
  baseline: number;
  openedValue: number;
  latestValue: number;
  worstValue: number;
  volume: number;
  examples: string[];
  changes: { kind: string; label: string; at: string }[];
  normalChecks: number;
  lastCheckedAt: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  resolution: "auto" | "manual" | "monitor_off" | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  note: string;
  version: string;
};
type IncidentsData = { open: Incident[]; recent: Incident[] };

export function IncidentsPage({
  menu,
  page,
  onConversation,
}: {
  menu: SideMenuState;
  page: Page;
  onConversation: (id: string) => void;
}) {
  const [data, setData] = useState<IncidentsData | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () =>
    api<IncidentsData>("zoe?view=incidents")
      .then(setData)
      .catch((e) => setError(message(e, "This page could not be loaded.")));
  useEffect(() => {
    void load();
  }, []);
  async function act(i: Incident, action: "acknowledge" | "resolve", note: string) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      setData(
        await api<IncidentsData>("zoe-monitors", { action, incidentId: i.id, version: i.version, note }),
      );
      setStatus(action === "acknowledge" ? "Acknowledged." : "Resolved.");
    } catch (e) {
      setError(message(e, "The incident could not be changed."));
      void load();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <p role="status" className="pg-muted pg-zoe-review-status">
        {status}
      </p>
      {data && (
        <>
          {data.open.length ? (
            <ul className="pg-zoe-incidents" aria-label="Open incidents">
              {data.open.map((i) => (
                <OpenIncident
                  key={i.id + i.version}
                  i={i}
                  busy={busy}
                  onAct={act}
                  onConversation={onConversation}
                />
              ))}
            </ul>
          ) : (
            <p className="pg-zoe-empty pg-zoe-incidents-none">
              <CheckCircle2 size={16} aria-hidden="true" /> No open incidents. Her monitors are watching.
            </p>
          )}
          <Card title="Resolved in the last 30 days">
            {data.recent.length ? (
              <ul className="pg-settings-list" aria-label="Resolved incidents">
                {data.recent.map((i) => (
                  <li key={i.id}>
                    <span>
                      <strong>{changeSentence(i.metric, i.baseline, i.openedValue)}</strong>
                      <small className="pg-muted">
                        Opened {ago(i.openedAt)} ·{" "}
                        {i.resolution === "auto"
                          ? "resolved by itself after two normal checks"
                          : i.resolution === "monitor_off"
                            ? `resolved when ${i.resolvedBy ?? "someone"} switched the monitor off`
                            : `resolved by ${i.resolvedBy ?? "a teammate"}`}{" "}
                        {i.resolvedAt ? ago(i.resolvedAt) : ""}
                      </small>
                      {i.note && <small>“{i.note}”</small>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pg-zoe-empty">None.</p>
            )}
          </Card>
        </>
      )}
    </Frame>
  );
}

function OpenIncident({
  i,
  busy,
  onAct,
  onConversation,
}: {
  i: Incident;
  busy: boolean;
  onAct: (i: Incident, action: "acknowledge" | "resolve", note: string) => Promise<void>;
  onConversation: (id: string) => void;
}) {
  const [note, setNote] = useState("");
  const title = changeSentence(i.metric, i.baseline, i.openedValue);
  return (
    <li className="pg-zoe-incident" aria-label={title}>
      <header>
        <AlertTriangle size={18} aria-hidden="true" />
        <strong>{title}</strong>
        <span className="pg-zoe-review-why" data-hue={i.status === "acknowledged" ? "amber" : "rose"}>
          {i.status === "acknowledged" ? `Acknowledged by ${i.acknowledgedBy ?? "a teammate"}` : "Open"}
        </span>
      </header>
      <p className="pg-muted">
        Opened {ago(i.openedAt)}. Now {percent(i.latestValue)} of {i.volume} in the last 24 hours (at worst{" "}
        {percent(i.worstValue)}), against {percent(i.baseline)} usually.{" "}
        {i.normalChecks
          ? `Normal at the last check; one more normal check resolves it.`
          : "Resolves by itself after two normal checks in a row."}
      </p>
      {i.note && <p>“{i.note}”</p>}
      <div className="pg-zoe-incident-detail">
        <section aria-label="Example conversations">
          <h4>Example conversations</h4>
          {i.examples.length ? (
            <ul>
              {i.examples.map((c) => (
                <li key={c}>
                  <button type="button" className="pg-link-button" onClick={() => onConversation(c)}>
                    Conversation {c.slice(0, 8)}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pg-muted">None to show.</p>
          )}
        </section>
        <section aria-label="What changed shortly before">
          <h4>What changed shortly before</h4>
          {i.changes.length ? (
            <ul>
              {i.changes.map((c, n) => (
                <li key={n}>
                  {c.label} <small className="pg-muted">{ago(c.at)}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pg-muted">
              Nothing in her settings, guidance, specialists or content in the 2 days before.
            </p>
          )}
        </section>
      </div>
      <label className="pg-zoe-review-note">
        <span>Note (optional)</span>
        <textarea value={note} maxLength={1000} rows={2} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="pg-zoe-review-actions">
        {i.status === "open" && (
          <button
            type="button"
            className="pg-zoe-secondary"
            disabled={busy}
            onClick={() => void onAct(i, "acknowledge", note)}
          >
            Acknowledge
          </button>
        )}
        <button
          type="button"
          className="pg-zoe-primary"
          disabled={busy}
          onClick={() => void onAct(i, "resolve", note)}
        >
          Resolve
        </button>
      </div>
    </li>
  );
}

/** The Overview's banner while incidents are open. */
export function IncidentBanner({
  open,
  onIncidents,
}: {
  open: { id: string; metric: string; baseline: number; latestValue: number }[];
  onIncidents: () => void;
}) {
  if (!open.length) return null;
  return (
    <section className="pg-zoe-incident-banner" role="status" aria-label="Open incidents">
      <AlertTriangle size={18} aria-hidden="true" />
      <span>
        <strong>
          {open.length === 1 ? "1 open incident" : `${open.length} open incidents`}
        </strong>
        <small>{open.map((i) => changeSentence(i.metric, i.baseline, i.latestValue)).join(" · ")}</small>
      </span>
      <button type="button" className="pg-zoe-secondary" onClick={onIncidents}>
        View incidents
      </button>
    </section>
  );
}

