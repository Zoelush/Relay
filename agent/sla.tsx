import { useEffect, useState } from "react";
import { Timer } from "lucide-react";

export type SlaClock = {
  metric: string;
  name: string;
  cycle: number;
  state: "running" | "paused" | "stopped" | "inactive";
  targetMs: number;
  elapsedMs: number;
  dueAt: string | null;
  breachedAt: string | null;
};
export type SlaContext = {
  enabled: boolean;
  serverNow?: string;
  policy: { id: string; name: string; hours: string } | null;
  clocks: SlaClock[];
};

/** "2d 3h", "1h 42m", "35m", "under a minute". */
export function duration(ms: number) {
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  if (minutes < 1) return "under a minute";
  const d = Math.floor(minutes / 1440),
    h = Math.floor((minutes % 1440) / 60),
    m = minutes % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
/** The current time, refreshed every `every` ms, shifted by the server's clock offset. */
function useNow(every: number, offset = 0) {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + offset), every);
    return () => clearInterval(timer);
  }, [every, offset]);
  return now;
}
const time = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** A list row's SLA: time to the next due time, or overdue. Wall time, from the server's due instant. */
export function SlaBadge({
  dueAt,
  overdue,
  chip,
}: {
  dueAt: string | null;
  overdue: boolean;
  /** As a chip with a timer icon (the list cards and the conversation header). */
  chip?: boolean;
}) {
  const now = useNow(30_000);
  if (chip) {
    if (!overdue && !dueAt) return null;
    const left = overdue ? 0 : new Date(dueAt!).getTime() - now;
    const text = overdue
      ? "SLA overdue"
      : left <= 0
        ? "SLA due now"
        : duration(left);
    return (
      <span
        className={
          "pg-sla-chip" +
          (overdue
            ? " pg-sla-overdue"
            : left < 15 * 60_000
              ? " pg-sla-soon"
              : "")
        }
        title={overdue ? "SLA overdue" : `Next SLA target in ${duration(left)}`}
      >
        <Timer size={12} aria-hidden="true" />
        {!overdue && left > 0 && (
          <span className="pg-visually-hidden">SLA due in </span>
        )}
        {text}
      </span>
    );
  }
  if (overdue)
    return <span className="pg-sla-badge pg-sla-overdue"> · SLA overdue</span>;
  if (!dueAt) return null;
  const left = new Date(dueAt).getTime() - now;
  return (
    <span
      className={
        left < 15 * 60_000 ? "pg-sla-badge pg-sla-soon" : "pg-sla-badge"
      }
    >
      {" "}
      · SLA {left <= 0 ? "due now" : duration(left)}
    </span>
  );
}

/** The sidebar's SLA section: the policy, and each clock's state with a live countdown. */
export function SlaSection({
  sla,
  receivedAt,
}: {
  sla: SlaContext;
  receivedAt: number;
}) {
  const offset = sla.serverNow
    ? new Date(sla.serverNow).getTime() - receivedAt
    : 0;
  const now = useNow(15_000, offset);
  if (!sla.enabled) return null;
  return (
    <section aria-labelledby="ctx-sla" className="pg-sla">
      <h3 id="ctx-sla">SLA</h3>
      {!sla.policy && !sla.clocks.length ? (
        <p className="pg-empty">No SLA policy applies.</p>
      ) : (
        <>
          {sla.policy && (
            <p className="pg-sla-policy">
              {sla.policy.name} ·{" "}
              {sla.policy.hours === "business" ? "business hours" : "all hours"}
            </p>
          )}
          <ul>
            {sla.clocks.map((k) => {
              let text: string, tone: string;
              if (k.state === "running" && k.breachedAt) {
                text = `Overdue by ${duration(now - new Date(k.breachedAt).getTime())}`;
                tone = "overdue";
              } else if (k.state === "running" && k.dueAt) {
                const left = new Date(k.dueAt).getTime() - now;
                text =
                  left <= 0
                    ? "Due now"
                    : `Due ${time(k.dueAt)} · in ${duration(left)}`;
                tone = left < 15 * 60_000 ? "soon" : "running";
              } else if (k.state === "paused") {
                text = `Paused · ${duration(k.targetMs - k.elapsedMs)} left`;
                tone = "paused";
              } else if (k.breachedAt) {
                text = "Breached";
                tone = "overdue";
              } else {
                text = "Met";
                tone = "met";
              }
              return (
                <li
                  key={k.metric + ":" + k.cycle}
                  className={`pg-sla-clock pg-sla-${tone}`}
                  data-testid={`sla-${k.metric}`}
                >
                  <strong>{k.name}</strong>
                  <span>{text}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
