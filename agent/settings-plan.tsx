import { useEffect, useState } from "react";
import { Check, Minus } from "lucide-react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › Billing › Plan (phase 16, step C8a; docs/SECURITY_STEP14.md), for `billing.manage`:
 * the workspace's plan, what each tier includes, how much of each limit is used, and the prices.
 * Everything here is computed by the server from the plan policy; choosing a plan comes with
 * billing (C10).
 */
type PlanRow = { id: string; name: string; summary: string; monthlyCents: number | null; annualMonthlyCents: number | null; features: string[]; limits: Record<string, number | null> };
type PlanData = {
  plan: string;
  plans: PlanRow[];
  features: Record<string, string>;
  usage: Record<string, { label: string; limit: number | null; used: number }>;
  pricesSet: boolean;
};
const money = (cents: number | null) => (cents === null ? "Not set yet" : `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);

export function PlanPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<PlanData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<PlanData>("plan")
      .then(setData)
      .catch((e) => setError(message(e, "Your plan couldn't be loaded.")));
  }, []);
  const current = data?.plans.find((p) => p.id === data.plan);
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {data && current && (
        <>
          <Card title={`You're on ${current.name}`} description={current.summary}>
            <ul className="pg-settings-list" aria-label="Plan limits">
              {Object.entries(data.usage).map(([id, u]) => (
                <li key={id}>
                  <span>
                    {u.label}: {u.used} of {u.limit === null ? "unlimited" : u.limit}
                  </span>
                </li>
              ))}
            </ul>
            <p className="pg-muted">Changing plan comes with billing. Limited seats are free on every plan.</p>
          </Card>
          <Card title="Compare plans" description="Every plan has the inbox, messenger, email, a help center, tickets, macros, reports, Zoe, the API, data requests, two-factor, the audit log and the health check.">
            <div className="pg-trust-scroll">
              <table className="pg-trust-table" aria-label="Compare plans">
                <thead>
                  <tr>
                    <th scope="col">Feature</th>
                    {data.plans.map((p) => (
                      <th key={p.id} scope="col" aria-current={p.id === data.plan ? "true" : undefined}>
                        {p.name}
                        {p.id === data.plan ? " (yours)" : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.features).map(([id, label]) => (
                    <tr key={id}>
                      <th scope="row">{label}</th>
                      {data.plans.map((p) => (
                        <td key={p.id}>
                          {p.features.includes(id) ? <Check size={15} aria-label="Included" /> : <Minus size={15} aria-label="Not included" />}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {Object.entries(data.usage).map(([id, u]) => (
                    <tr key={id}>
                      <th scope="row">{u.label}</th>
                      {data.plans.map((p) => (
                        <td key={p.id}>{p.limits[id] === null ? "Unlimited" : p.limits[id]}</td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <th scope="row">Full seat, per month</th>
                    {data.plans.map((p) => (
                      <td key={p.id}>{money(p.monthlyCents)}</td>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row">Full seat, per month billed yearly</th>
                    {data.plans.map((p) => (
                      <td key={p.id}>{money(p.annualMonthlyCents)}</td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            {!data.pricesSet && <p className="pg-muted">Prices haven&apos;t been set yet.</p>}
          </Card>
        </>
      )}
    </Frame>
  );
}
