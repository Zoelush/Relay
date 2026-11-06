import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › Billing › Seats (phase 16, step C8b; docs/SECURITY_STEP15.md), for `billing.manage`:
 * who occupies a full or limited seat, this period's seats with prorated additions (computed by the
 * server from the seat ledger), and changing a teammate's seat.
 */
type Proration = { teammateId: string; teammateName: string; at: string; fraction: number; amountCents: number | null };
type Seats = {
  plan: string;
  priceSet: boolean;
  period: { start: string; end: string };
  full: number;
  limited: number;
  bill: { fullAtStart: number; baseCents: number | null; prorations: Proration[]; proratedCents: number | null; fullNextPeriod: number };
  teammates: { id: string; name: string; role: string; seat: "full" | "limited"; owner: boolean; since: string | null }[];
};
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const money = (cents: number | null) => (cents === null ? "Price not set" : `$${(cents / 100).toFixed(2)}`);

export function SeatsPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Seats | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(
    () =>
      api<Seats>("seats")
        .then(setData)
        .catch((e) => setError(message(e, "Seats couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const change = async (teammateId: string, name: string, seat: "full" | "limited") => {
    setError("");
    setNotice("");
    try {
      setData(await api<Seats>("seats", { teammateId, seat }));
      setNotice(seat === "full" ? `${name} has a full seat.` : `${name} has a limited seat.`);
    } catch (e) {
      setError(message(e, "The seat couldn't be changed."));
      void load();
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
          <Card
            title="This period"
            description={`${day(data.period.start)} to ${day(data.period.end)}, on ${data.plan}. A full seat added now is charged for the rest of the period; one removed stays paid until it ends.`}
          >
            <ul className="pg-settings-list" aria-label="Seat summary">
              <li>
                <span>
                  Full seats now: {data.full} · Limited seats (free): {data.limited}
                </span>
              </li>
              <li>
                <span>
                  Full seats at the start of the period: {data.bill.fullAtStart} ({money(data.bill.baseCents)})
                </span>
              </li>
              <li>
                <span>Full seats next period: {data.bill.fullNextPeriod}</span>
              </li>
            </ul>
            {data.bill.prorations.length > 0 && (
              <ul className="pg-settings-list" aria-label="Added this period">
                {data.bill.prorations.map((p) => (
                  <li key={p.teammateId + p.at}>
                    <span>
                      {p.teammateName}, {day(p.at)}: {Math.round(p.fraction * 100)}% of the period ({money(p.amountCents)})
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {!data.priceSet && <p className="pg-muted">Prices haven&apos;t been set yet, so amounts aren&apos;t shown.</p>}
          </Card>
          <Card title="Who has a seat" description="A full seat can do everything their role allows. A limited seat is free: it reads conversations opened from a link, mention or notification, adds notes and sees reports.">
            <ul className="pg-settings-list" aria-label="Teammates' seats">
              {data.teammates.map((t) => (
                <li key={t.id}>
                  <span>
                    <strong>{t.name}</strong> <small className="pg-muted">{t.role}</small>
                  </span>
                  <select
                    aria-label={`Seat for ${t.name}`}
                    value={t.seat}
                    disabled={t.owner}
                    title={t.owner ? "The owner always has a full seat." : undefined}
                    onChange={(e) => void change(t.id, t.name, e.target.value as "full" | "limited")}
                  >
                    <option value="full">Full</option>
                    <option value="limited">Limited</option>
                  </select>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </Frame>
  );
}
