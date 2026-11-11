import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › Billing › Usage (phase 16, step C9a; docs/SECURITY_STEP16.md), for `billing.manage`:
 * each meter's usage this billing period or the last, its price and amount, and every unit traced
 * back to its conversation. The server reads each meter from its source records; nothing is counted.
 * C9b: each meter's limit and the spend cap, which pause automated sends only (docs/SECURITY_STEP17.md).
 */
type Meter = { id: string; label: string; unit: string; source: string; quantity: number; priceCents: number | null; amountCents: number | null };
type Limits = {
  limits: Record<string, number | null>;
  spendCapCents: number | null;
  capApplies: boolean;
  spentCents: number | null;
  paused: Record<string, string>;
  /** C9c: when billing managers are told, as percentages. */
  alertThresholds: number[];
};
type Usage = { period: { which: string; start: string; end: string }; meters: Meter[]; totalCents: number | null; pricesSet: boolean; limits: Limits };
type Unit = { id: string; at: string; quantity: number; conversationId: string | null; contactId: string | null; detail: string };
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const money = (cents: number | null) => (cents === null ? "Price not set" : `$${(cents / 100).toFixed(2)}`);

function Units({ meter, period }: { meter: Meter; period: string }) {
  const [units, setUnits] = useState<Unit[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    (cursor: string | null) =>
      api<{ units: Unit[]; next: string | null }>(`usage-units?meter=${meter.id}&period=${period}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
        .then((r) => {
          setUnits((u) => (cursor ? [...u, ...r.units] : r.units));
          setNext(r.next);
        })
        .catch((e) => setError(message(e, "The units couldn't be loaded."))),
    [meter.id, period],
  );
  useEffect(() => {
    void load(null);
  }, [load]);
  return (
    <>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {units.length ? (
        <ul className="pg-settings-list" aria-label={`${meter.label} units`}>
          {units.map((u) => (
            <li key={u.id}>
              <span>
                {time(u.at)} · {u.quantity} {u.quantity === 1 || u.quantity === -1 ? meter.unit : meter.unit + "s"}
                {u.detail ? <small className="pg-muted"> · {u.detail}</small> : null}
              </span>
              {u.conversationId ? (
                <a className="pg-wf-link" href={`#conversation/${u.conversationId}`}>
                  Open conversation
                </a>
              ) : u.contactId ? (
                <small className="pg-muted">Contact {u.contactId.slice(0, 8)}</small>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        !error && <p className="pg-muted">None this period.</p>
      )}
      {next && (
        <button type="button" className="pg-secondary" onClick={() => void load(next)}>
          Show more
        </button>
      )}
    </>
  );
}

export function UsagePage({ menu, page }: { menu: MenuState; page: Page }) {
  const [which, setWhich] = useState<"current" | "previous">("current");
  const [data, setData] = useState<Usage | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [cap, setCap] = useState("");
  const [alerts, setAlerts] = useState("");
  const take = (u: Usage) => {
    setData(u);
    setDraft(Object.fromEntries(Object.entries(u.limits.limits).map(([m, v]) => [m, v === null ? "" : String(v)])));
    setCap(u.limits.spendCapCents === null ? "" : (u.limits.spendCapCents / 100).toFixed(2));
    setAlerts(u.limits.alertThresholds.join(", "));
  };
  useEffect(() => {
    api<Usage>(`usage?period=${which}`)
      .then(take)
      .catch((e) => setError(message(e, "Usage couldn't be loaded.")));
  }, [which]);
  const saveLimits = async () => {
    setError("");
    setNotice("");
    try {
      const limits = Object.fromEntries(Object.entries(draft).map(([m, v]) => [m, v.trim() === "" ? null : Number(v)]));
      const spendCapCents = cap.trim() === "" ? null : Math.round(Number(cap) * 100);
      const alertThresholds = alerts
        .split(",")
        .map((x) => x.trim().replace(/%$/, ""))
        .filter(Boolean)
        .map(Number);
      const u = await api<Usage>("usage", { action: "limits", limits, spendCapCents, alertThresholds });
      if (which === "current") take(u);
      else setWhich("current");
      setNotice("Limits saved.");
    } catch (e) {
      setError(message(e, "The limits couldn't be saved."));
    }
  };
  return (
    <Frame menu={menu} page={page}>
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
      {data && (
        <>
          <Card title="Usage" description={`${day(data.period.start)} to ${day(data.period.end)}. Every unit is read from what it counts (a message sent, a call, a resolution), and can be traced to its conversation.`}>
            <label className="pg-settings-field">
              <span className="pg-settings-label">Period</span>
              <select
                value={which}
                onChange={(e) => {
                  setOpen(null);
                  setWhich(e.target.value as "current" | "previous");
                }}
              >
                <option value="current">This period</option>
                <option value="previous">Last period</option>
              </select>
            </label>
            <div className="pg-trust-scroll">
              <table className="pg-trust-table" aria-label="Usage by meter">
                <thead>
                  <tr>
                    <th scope="col">Meter</th>
                    <th scope="col">Units</th>
                    <th scope="col">Price per unit</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Limit</th>
                    <th scope="col">
                      <span className="pg-visually-hidden">Units</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.meters.map((m) => (
                    <tr key={m.id}>
                      <th scope="row" title={m.source}>
                        {m.label}
                      </th>
                      <td>{m.quantity.toLocaleString()}</td>
                      <td>{money(m.priceCents)}</td>
                      <td>{money(m.amountCents)}</td>
                      <td>
                        {data.limits.limits[m.id] === null ? "None" : data.limits.limits[m.id]!.toLocaleString()}
                        {data.limits.paused[m.id] && (
                          <span className="pg-health-badge" data-severity="critical" title={data.limits.paused[m.id]}>
                            {" "}
                            Paused
                          </span>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="pg-wf-link"
                          aria-expanded={open === m.id}
                          aria-label={`${open === m.id ? "Hide" : "See"} units: ${m.label}`}
                          onClick={() => setOpen(open === m.id ? null : m.id)}
                        >
                          {open === m.id ? "Hide units" : "See units"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="pg-health-summary">Total: {data.pricesSet ? money(data.totalCents) : "Prices haven't been set yet"}</p>
          </Card>
          <Card
            title="Limits and spend cap"
            description="Reaching a limit, or the spend cap, pauses automated sends only: Zoe hands conversations to the team, outbound messages and automated emails, WhatsApp and SMS wait, and Zoe's and workflows' connector calls stop. Teammates' replies, calls and the inbox always keep working."
          >
            <form
              className="pg-signin-settings"
              aria-label="Usage limits"
              onSubmit={(e) => {
                e.preventDefault();
                void saveLimits();
              }}
            >
              {data.meters.map((m) => (
                <label key={m.id} className="pg-settings-field">
                  <span className="pg-settings-label">{m.label}</span>
                  <input
                    inputMode="numeric"
                    placeholder="No limit"
                    value={draft[m.id] ?? ""}
                    onChange={(e) => setDraft({ ...draft, [m.id]: e.target.value })}
                  />
                </label>
              ))}
              <label className="pg-settings-field">
                <span className="pg-settings-label">Spend cap per period (USD)</span>
                <input inputMode="decimal" placeholder="No cap" value={cap} onChange={(e) => setCap(e.target.value)} aria-describedby="cap-hint" />
                <small id="cap-hint" className="pg-muted">
                  {data.limits.capApplies
                    ? `Spent so far this period: ${money(data.limits.spentCents)}.`
                    : "Prices haven't been set yet, so a spend cap can be saved but isn't applied."}
                </small>
              </label>
              <label className="pg-settings-field">
                <span className="pg-settings-label">Alert at (% of each limit and the cap)</span>
                <input placeholder="No alerts" value={alerts} onChange={(e) => setAlerts(e.target.value)} aria-describedby="alerts-hint" />
                <small id="alerts-hint" className="pg-muted">
                  Everyone who manages billing gets a notification and an email once per threshold each period, such as 80, 100.
                </small>
              </label>
              <span className="pg-settings-buttons">
                <button type="submit" className="pg-primary">
                  Save limits
                </button>
              </span>
            </form>
          </Card>
          {open && (
            <Card title={data.meters.find((m) => m.id === open)!.label} description={data.meters.find((m) => m.id === open)!.source}>
              <Units key={`${open}-${which}`} meter={data.meters.find((m) => m.id === open)!} period={which} />
            </Card>
          )}
        </>
      )}
    </Frame>
  );
}
