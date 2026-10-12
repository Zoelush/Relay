/**
 * Zoe's built-in monitors (phase 08, step C2b; docs/AI_STEP12.md), shared by the server
 * (`server/zoe-monitors.ts`) and her Monitors and Incidents pages. Each is a rate over the last 24
 * hours, compared with the 7 days before; `worse` says which way is bad.
 */
export const MONITORS = [
  {
    metric: "unknown_rate",
    name: "“I don't know” rate",
    description: "Questions she tried but couldn't answer from your content.",
    worse: "up",
    min: 20,
  },
  {
    metric: "handover_rate",
    name: "Handover rate",
    description: "Messages she handed to your team, for any reason.",
    worse: "up",
    min: 20,
  },
  {
    metric: "blocked_rate",
    name: "Blocked by safety",
    description: "Replies the guards in code stopped before they reached a customer.",
    worse: "up",
    min: 20,
  },
  {
    metric: "error_rate",
    name: "Error rate",
    description: "Questions she couldn't answer because a model or the index failed.",
    worse: "up",
    min: 20,
  },
  {
    metric: "helped_rate",
    name: "“That helped” rate",
    description: "Answers the customer confirmed helped.",
    worse: "down",
    min: 20,
  },
  {
    metric: "bad_review_rate",
    name: "Rated bad in review",
    description: "Answers reviewers rated bad (with the review queue on).",
    worse: "up",
    min: 5,
  },
] as const;
export type Metric = (typeof MONITORS)[number]["metric"];
export type Sensitivity = "low" | "medium" | "high";
/**
 * How sharp a change must be: it must move by at least `points` (as a fraction) in the bad
 * direction, and by the `factor` (up: at least that multiple of the usual; down: at most the usual
 * divided by it).
 */
export const SENSITIVITY: Record<Sensitivity, { points: number; factor: number; name: string }> = {
  low: { points: 0.2, factor: 2.5, name: "Low: only large changes" },
  medium: { points: 0.1, factor: 2, name: "Medium" },
  high: { points: 0.05, factor: 1.5, name: "High: smaller changes too" },
};
export const monitorOf = (metric: string) => MONITORS.find((m) => m.metric === metric);

/** Whether a rate has changed sharply enough, the bad way, at this sensitivity. */
export function tripped(metric: Metric, sensitivity: Sensitivity, current: number, baseline: number) {
  const m = monitorOf(metric)!;
  const s = SENSITIVITY[sensitivity];
  return m.worse === "up"
    ? current - baseline >= s.points - 1e-9 && current >= baseline * s.factor
    : baseline - current >= s.points - 1e-9 && current * s.factor <= baseline;
}

export const percent = (n: number | null) =>
  n === null ? "—" : `${Math.round(n * 1000) / 10}%`;

/** "“I don't know” rate rose from 8% to 31%" */
export function changeSentence(metric: string, from: number, to: number) {
  const m = monitorOf(metric);
  return `${m?.name ?? metric} ${to >= from ? "rose" : "fell"} from ${percent(from)} to ${percent(to)}`;
}
