import { useEffect, useState } from "react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";
import type { Metric } from "../lib/metrics";

/**
 * Settings › Reporting data (phase 14, step R1; docs/REPORTING_STEP1.md), behind `reports_v1`, for
 * who may view reports: how current reporting's store is (it's fed from the inbox's data, a little
 * behind), and the metric dictionary: what every number in Reports means, exactly.
 */
type Status = { connected: boolean; asOf: string | null; conversations: number; metrics: Metric[] };
const DATASETS: Record<string, string> = {
  conversation: "Conversations",
  rating: "Ratings",
  sla: "SLAs",
  ticket: "Tickets",
  ai_agent: "AI agent",
  teammate: "Teammates",
  team: "Teams",
  outbound: "Outbound",
  article: "Articles",
  search: "Search",
  call: "Calls",
};

export function ReportingPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Status>("reporting-status")
      .then(setData)
      .catch((e) => setError(message(e, "Reporting data couldn't be loaded.")));
  }, []);
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {data && (
        <Card
          title="Reporting data"
          description="Reports read their own copy of your data, kept up to date in the background, so they never slow the inbox. A customer's details are as they were when each conversation started; only their name and email are shown as they are now."
        >
          <p aria-label="Reporting data status">
            {!data.connected
              ? "Reporting's store isn't connected."
              : data.asOf
                ? `Up to date as of ${new Date(data.asOf).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })} · ${data.conversations} ${data.conversations === 1 ? "conversation" : "conversations"}`
                : "Being prepared: the first copy is on its way."}
          </p>
        </Card>
      )}
      {data && (
        <Card title="What each number means" description="Every metric's formula, the time it's counted at, what's in and out, and how automation (Zoe, workflows, outbound) is treated.">
          {Object.entries(DATASETS)
            .filter(([id]) => data.metrics.some((m) => m.dataset === id))
            .map(([id, label]) => (
              <section key={id} aria-label={`${label} metrics`}>
                <h3 className="pg-settings-subhead">{label}</h3>
                <dl className="pg-metrics">
                  {data.metrics
                    .filter((m) => m.dataset === id)
                    .map((m) => (
                      <details key={m.id}>
                        <summary>{m.name}</summary>
                        <p>{m.formula}</p>
                        <p className="pg-muted">
                          <strong>Counted at:</strong> {m.anchor} <strong>Includes:</strong> {m.includes} <strong>Excludes:</strong> {m.excludes} <strong>Automation:</strong> {m.automation}
                        </p>
                      </details>
                    ))}
                </dl>
              </section>
            ))}
        </Card>
      )}
    </Frame>
  );
}
