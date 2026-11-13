import { useEffect, useState } from "react";
import { Check, Minus } from "lucide-react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › Billing › Plan (phase 16, step C8a; docs/SECURITY_STEP14.md), for `billing.manage`:
 * the workspace's plan, what each tier includes, how much of each limit is used, and the prices.
 * Everything here is computed by the server from the plan policy.
 *
 * C10b (docs/SECURITY_STEP21.md): the fortnight's trial, upgrading (which applies at once, its
 * difference prorated on the next invoice), and a downgrade that waits for the end of the period
 * already paid for and can be called off until then.
 */
type PlanRow = { id: string; name: string; summary: string; monthlyCents: number | null; annualMonthlyCents: number | null; features: string[]; limits: Record<string, number | null> };
type Change = { kind: string; from: string; to: string; at: string; effectiveAt: string; by: string | null };
type PlanData = {
  plan: string;
  plans: PlanRow[];
  features: Record<string, string>;
  usage: Record<string, { label: string; limit: number | null; used: number }>;
  pricesSet: boolean;
  trial: { plan: string; endsAt: string; days: number } | null;
  trialAvailable: boolean;
  trialPlan: string;
  trialDays: number;
  pending: { plan: string; from: string } | null;
  periodEnd: string | null;
  history: Change[];
};
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
const daysLeft = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
const WORDS: Record<string, string> = {
  trial_started: "Trial started",
  trial_ended: "Trial ended",
  upgraded: "Upgraded",
  downgrade_scheduled: "Change scheduled",
  downgrade_cancelled: "Change called off",
  downgraded: "Changed",
};
const money = (cents: number | null) => (cents === null ? "Not set yet" : `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);

export function PlanPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<PlanData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    api<PlanData>("plan")
      .then(setData)
      .catch((e) => setError(message(e, "Your plan couldn't be loaded.")));
  }, []);
  const current = data?.plans.find((p) => p.id === data.plan);
  const change = async (what: string, body: Record<string, unknown>, done: string) => {
    setBusy(what);
    setError("");
    setNotice("");
    try {
      setData(await api<PlanData>("plan", body));
      setNotice(done);
    } catch (e) {
      setError(message(e, "That didn't work."));
    } finally {
      setBusy("");
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
      {data && current && (
        <>
          <Card title={`You're on ${current.name}`} description={current.summary}>
            {data.trial && (
              <p className="pg-settings-value">
                Your trial of {data.plans.find((p) => p.id === data.trial!.plan)?.name ?? data.trial.plan} has{" "}
                {daysLeft(data.trial.endsAt)} {daysLeft(data.trial.endsAt) === 1 ? "day" : "days"} left; it ends on {day(data.trial.endsAt)}.
              </p>
            )}
            {data.pending && (
              <p className="pg-settings-value">
                You move to {data.plans.find((p) => p.id === data.pending!.plan)?.name ?? data.pending.plan} on {day(data.pending.from)}. Your
                data stays; what the smaller plan doesn&apos;t include stops being available to add to.
              </p>
            )}
            <ul className="pg-settings-list" aria-label="Plan limits">
              {Object.entries(data.usage).map(([id, u]) => (
                <li key={id}>
                  <span>
                    {u.label}: {u.used} of {u.limit === null ? "unlimited" : u.limit}
                  </span>
                </li>
              ))}
            </ul>
            <p className="pg-muted">Limited seats are free on every plan.</p>
            <div className="pg-plan-actions">
              {data.trialAvailable && (
                <button
                  type="button"
                  className="pg-primary"
                  disabled={busy === "trial"}
                  onClick={() => void change("trial", { action: "start_trial" }, `Your ${data.trialDays}-day trial has started.`)}
                >
                  Start the {data.trialDays}-day {data.plans.find((p) => p.id === data.trialPlan)?.name ?? data.trialPlan} trial
                </button>
              )}
              {data.pending && (
                <button type="button" className="pg-secondary" disabled={busy === "cancel"} onClick={() => void change("cancel", { action: "cancel_change" }, "The change is called off.")}>
                  Keep {current.name}
                </button>
              )}
            </div>
          </Card>
          <Card
            title="Change plan"
            description="An upgrade applies at once, and its difference for the rest of this period is on your next invoice. A move to a smaller plan waits until the period you have paid for ends."
          >
            <ul className="pg-settings-list" aria-label="Change plan">
              {data.plans
                .filter((p) => p.id !== data.plan)
                .map((p) => {
                  const up = data.plans.findIndex((x) => x.id === p.id) > data.plans.findIndex((x) => x.id === data.plan);
                  return (
                    <li key={p.id}>
                      <span>
                        <strong>{p.name}</strong>
                        <small className="pg-muted">
                          {p.summary} · {money(p.monthlyCents)} per full seat
                        </small>
                      </span>
                      <button
                        type="button"
                        className={up ? "pg-primary" : "pg-secondary"}
                        disabled={busy === p.id || data.pending?.plan === p.id}
                        onClick={() =>
                          void change(p.id, { action: "change", plan: p.id }, up ? `You're on ${p.name}.` : `You move to ${p.name} when this period ends.`)
                        }
                      >
                        {data.pending?.plan === p.id ? "Already scheduled" : up ? `Upgrade to ${p.name}` : `Move to ${p.name}`}
                      </button>
                    </li>
                  );
                })}
            </ul>
            {data.periodEnd && <p className="pg-muted">This period ends on {day(data.periodEnd)}.</p>}
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
          {data.history.length > 0 && (
            <Card title="What has happened" description="Every change to this workspace's plan, newest first.">
              <ul className="pg-settings-list" aria-label="Plan history">
                {data.history.map((h, i) => (
                  <li key={i}>
                    <span>
                      {WORDS[h.kind] ?? h.kind}: {data.plans.find((p) => p.id === h.from)?.name ?? h.from} to{" "}
                      {data.plans.find((p) => p.id === h.to)?.name ?? h.to}
                      <small className="pg-muted">
                        {day(h.at)}
                        {h.by ? ` · ${h.by}` : ""}
                        {h.effectiveAt !== h.at ? ` · from ${day(h.effectiveAt)}` : ""}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </Frame>
  );
}
