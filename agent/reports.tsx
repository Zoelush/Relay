import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bot,
  ChartColumnBig,
  Clock,
  Headphones,
  Info,
  LayoutDashboard,
  LifeBuoy,
  Mail,
  Megaphone,
  Minus,
  Phone,
  Repeat,
  ShieldCheck,
  Smile,
  Ticket,
  Timer,
  UserCheck,
  Users,
} from "lucide-react";
import { api } from "./api";
import { ShowMenuButton, SideMenu, useSideMenu } from "./shell";
import { message } from "./settings-ui";
import { metric as definition, type Metric } from "../lib/metrics";
import { BETTER, ITEM_LABELS, PREBUILT, REPORT_GROUPS, type Breakdown, type Chart, type PrebuiltReport } from "../lib/reports";
import { CHANNEL_LABELS, channelLabel } from "../lib/channels";

/**
 * Reports (phase 14, step R3; docs/REPORTING_STEP3.md), behind `reports_v1`, for who may view
 * reports, at `#reports` (the overview) and `#reports/<report>`: after Intercom's Reports. Every
 * number comes from the analytical store through `report-metric` (one metric, its previous period
 * and its breakdown, defined once in `lib/metrics.ts`); the page only lays them out. Each chart's
 * definition is one click away, from the same dictionary. Counts, medians and shares are computed on
 * the server; here they're only formatted.
 */
type Value =
  | { kind: "count"; count: number }
  | { kind: "share"; percent: number | null; numerator: number; denominator: number }
  | { kind: "duration"; count: number; medianMs: number | null; averageMs: number | null; medianBusinessMs: number | null; averageBusinessMs: number | null }
  | { kind: "rate"; value: number | null; numerator: number; denominator: number }
  | { kind: "time"; label: string | null; count: number };
type Answer = { metric: string; total: Value; previous: Value; rows: { key: string | null; value: Value }[]; labels: Record<string, string> };
type Flow = {
  total: number;
  zoe: { total: number; resolved: number; handedOver: number; other: number };
  teammate: { total: number; closed: number; open: number };
  closedWithoutReply: number;
  waiting: number;
};
type Directory = { teammates: { id: string; name: string }[]; teams: { id: string; name: string }[] };
type Range = { preset: string; from?: string; to?: string };
type Query = { from: string; to: string; timezone: string; filters: { channel?: string; teamId?: string }; officeHours: boolean };

const PRESETS = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
  { id: "12m", label: "12 months", days: 365 },
  { id: "custom", label: "Custom" },
] as const;
const ICONS: Record<string, React.ReactNode> = {
  overview: <LayoutDashboard size={16} />,
  conversations: <ChartColumnBig size={16} />,
  responsiveness: <Timer size={16} />,
  slas: <ShieldCheck size={16} />,
  team_performance: <Users size={16} />,
  teammate_performance: <UserCheck size={16} />,
  csat: <Smile size={16} />,
  effectiveness: <Repeat size={16} />,
  tickets: <Ticket size={16} />,
  calls: <Phone size={16} />,
  email_deliverability: <Mail size={16} />,
  ai_agent: <Bot size={16} />,
  human_in_the_loop: <Headphones size={16} />,
  outbound: <Megaphone size={16} />,
  help_center: <LifeBuoy size={16} />,
};
// Each chart takes a tint in turn, so a page reads as a set rather than a wall of one colour.
const HUES = ["violet", "blue", "teal", "amber", "sky", "rose", "green"] as const;
const PREFS = "relay-reports";

/** The browser's timezone, else UTC. */
const localZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};
const zones = () => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
};
/** What the viewer last chose (a convenience: without storage, the defaults). */
function savedPrefs(): { range: Range; timezone: string; officeHours: boolean } {
  const fallback = { range: { preset: "30d" }, timezone: localZone(), officeHours: false };
  try {
    const v = JSON.parse(localStorage.getItem(PREFS) ?? "null");
    return v && typeof v === "object" ? { ...fallback, ...v } : fallback;
  } catch {
    return fallback;
  }
}
/** The start of today in a timezone, as an instant. */
function startOfToday(tz: string, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const since = (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000;
  return new Date(now.getTime() - since - now.getMilliseconds());
}
/** The period a range means, now. */
function period(range: Range, tz: string): { from: Date; to: Date } {
  const to = new Date(Math.ceil(Date.now() / 60_000) * 60_000);
  if (range.preset === "custom" && range.from && range.to) {
    const from = new Date(range.from + "T00:00:00");
    const end = new Date(range.to + "T00:00:00");
    end.setDate(end.getDate() + 1);
    if (end > from) return { from, to: end };
  }
  if (range.preset === "today") return { from: startOfToday(tz), to };
  const days = PRESETS.find((p) => p.id === range.preset && "days" in p) as { days: number } | undefined;
  return { from: new Date(to.getTime() - (days?.days ?? 30) * 86_400_000), to };
}

// Formatting: the server computes; the page writes it down.
const fmtCount = (n: number) => n.toLocaleString();
function fmtDuration(ms: number | null) {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const units: [string, number][] = [
    ["d", Math.floor(s / 86_400)],
    ["h", Math.floor((s % 86_400) / 3600)],
    ["m", Math.floor((s % 3600) / 60)],
    ["s", s % 60],
  ];
  const first = units.findIndex(([, v]) => v > 0);
  return units
    .slice(first, first + 2)
    .filter(([, v]) => v > 0)
    .map(([u, v]) => `${v}${u}`)
    .join(" ");
}
/** A value as one number to compare and chart (null when there's nothing to show). */
function numberOf(v: Value, officeHours: boolean): number | null {
  switch (v.kind) {
    case "count":
      return v.count;
    case "share":
      return v.percent;
    case "duration":
      return officeHours ? v.medianBusinessMs : v.medianMs;
    case "rate":
      return v.value;
    case "time":
      return v.count;
  }
}
function fmtValue(v: Value, officeHours: boolean): string {
  switch (v.kind) {
    case "count":
      return fmtCount(v.count);
    case "share":
      return v.percent === null ? "—" : `${v.percent}%`;
    case "duration":
      return fmtDuration(officeHours ? v.medianBusinessMs : v.medianMs);
    case "rate":
      return v.value === null ? "—" : v.value < 1 ? v.value.toFixed(2) : v.value.toFixed(1);
    case "time":
      return v.label ?? "—";
  }
}
/** What a value is made of, under the big number. */
function detailOf(v: Value): string {
  switch (v.kind) {
    case "share":
      return v.denominator ? `${fmtCount(v.numerator)} of ${fmtCount(v.denominator)}` : "None in this period";
    case "duration":
      return v.count ? `Median of ${fmtCount(v.count)}` : "None in this period";
    case "rate":
      return v.denominator ? `${fmtCount(v.numerator)} over ${fmtCount(Math.round(v.denominator))} active hours` : "No active hours";
    case "time":
      return v.count ? `${fmtCount(v.count)} customer messages in that hour` : "No customer messages";
    default:
      return "";
  }
}
/** The change from the previous period: a percentage, or points for a share; and whether it's good. */
function change(id: string, now: Value, before: Value, officeHours: boolean) {
  const a = numberOf(now, officeHours),
    b = numberOf(before, officeHours);
  if (a === null || b === null || now.kind === "time") return null;
  const diff = now.kind === "share" ? Math.round((a - b) * 10) / 10 : b === 0 ? (a === 0 ? 0 : null) : Math.round(((a - b) / b) * 1000) / 10;
  if (diff === null) return { text: "New", tone: "neutral" as const, dir: "up" as const };
  const dir = diff > 0 ? ("up" as const) : diff < 0 ? ("down" as const) : ("flat" as const);
  const better = BETTER[id];
  const tone = dir === "flat" || !better ? ("neutral" as const) : dir === better ? ("good" as const) : ("bad" as const);
  if (dir === "flat") return { text: "No change", tone, dir };
  return { text: `${diff > 0 ? "+" : ""}${diff}${now.kind === "share" ? " pts" : "%"}`, tone, dir };
}

/** A breakdown key, named. */
function labelOf(key: string | null, breakdown: Breakdown | undefined, a: Answer, dir: Directory): string {
  if (key === null) return breakdown === "team" ? "No team" : breakdown === "teammate" ? "Unassigned" : "None";
  if (a.labels[key]) return a.labels[key];
  if (breakdown === "channel") return channelLabel(key);
  if (breakdown === "teammate") return dir.teammates.find((t) => t.id === key)?.name ?? key;
  if (breakdown === "team") return dir.teams.find((t) => t.id === key)?.name ?? key;
  if (breakdown === "item") return ITEM_LABELS[key] ?? key;
  return key;
}
/** A day, week or month key as a short label. */
function periodLabel(key: string, breakdown: Breakdown) {
  if (breakdown === "week") return key.replace(/^\d{4}-W/, "W");
  if (breakdown === "month") return new Date(key + "-01T12:00:00Z").toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
  return new Date(key + "T12:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
}
const ymd = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
function isoWeek(key: string) {
  const d = new Date(key + "T12:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
/** Every period key from `from` to `to`, so a quiet day shows as a gap rather than disappearing. */
function periodKeys(from: Date, to: Date, tz: string, breakdown: Breakdown): string[] {
  const out: string[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += 86_400_000 / 2) {
    const day = ymd(new Date(t), tz);
    const key = breakdown === "week" ? isoWeek(day) : breakdown === "month" ? day.slice(0, 7) : day;
    if (out.at(-1) !== key && !out.includes(key)) out.push(key);
  }
  return out;
}
const isTime = (b?: Breakdown) => b === "day" || b === "week" || b === "month";
/** Day charts over a long period become weekly, so bars stay readable. */
const granularity = (b: Breakdown | undefined, from: Date, to: Date): Breakdown | undefined =>
  b === "day" && to.getTime() - from.getTime() > 62 * 86_400_000 ? "week" : b;

/** Asks for each chart's metric once per query, all at once; answers are kept by question. */
function useAnswers(charts: Chart[], q: Query) {
  const [answers, setAnswers] = useState<Record<string, Answer | { error: string }>>({});
  // Questions asked (by their key): each is asked once, and its answer kept for when it's asked again.
  const asked = useRef(new Set<string>());
  const [retries, setRetries] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const keyOf = useCallback((c: Chart) => JSON.stringify([c.metric, c.breakdown ?? null, q.from, q.to, q.timezone, q.filters]), [q.from, q.to, q.timezone, q.filters]);
  useEffect(() => {
    for (const c of charts) {
      const k = keyOf(c);
      if (asked.current.has(k)) continue;
      asked.current.add(k);
      api<Answer>("report-metric", { metric: c.metric, breakdown: c.breakdown, from: q.from, to: q.to, timezone: q.timezone, filters: q.filters }).then(
        (a) => mounted.current && setAnswers((s) => ({ ...s, [k]: a })),
        (e) => {
          asked.current.delete(k);
          if (mounted.current) setAnswers((s) => ({ ...s, [k]: { error: message(e, "This chart couldn't be loaded.") } }));
        },
      );
    }
  }, [charts, keyOf, q.from, q.to, q.timezone, q.filters, retries]);
  const retry = (c: Chart) => {
    asked.current.delete(keyOf(c));
    setAnswers((s) => {
      const next = { ...s };
      delete next[keyOf(c)];
      return next;
    });
    setRetries((n) => n + 1);
  };
  return { get: (c: Chart) => answers[keyOf(c)], retry };
}

export function Reports({ open, onOpen, directory, zoeName }: { open: string | null; onOpen: (report: string | null) => void; directory: Directory; zoeName: string }) {
  const menu = useSideMenu("reports");
  const [prefs, setPrefs] = useState(savedPrefs);
  const [filters, setFilters] = useState<Query["filters"]>({});
  const [status, setStatus] = useState<{ asOf: string | null; conversations: number } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    try {
      localStorage.setItem(PREFS, JSON.stringify(prefs));
    } catch {
      // A convenience only: without storage the page keeps its defaults.
    }
  }, [prefs]);
  useEffect(() => {
    api<{ asOf: string | null; conversations: number }>("reporting-status")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [tick]);
  const report = open ? PREBUILT.find((r) => r.id === open) : undefined;
  // The period is worked out once per choice (and on refresh), so every chart asks for the same one.
  const range = useMemo(() => period(prefs.range, prefs.timezone), [prefs.range, prefs.timezone, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const query: Query = useMemo(
    () => ({ from: range.from.toISOString(), to: range.to.toISOString(), timezone: prefs.timezone, filters, officeHours: prefs.officeHours }),
    [range, prefs.timezone, filters, prefs.officeHours],
  );
  const entry = (id: string, name: string) => (
    <li key={id} data-hue="violet">
      <button aria-current={(open ?? "overview") === id ? "page" : undefined} onClick={() => onOpen(id === "overview" ? null : id)}>
        <span className="pg-menu-entry-icon" aria-hidden="true">
          {ICONS[id]}
        </span>
        <span className="pg-menu-entry-name">{name}</span>
      </button>
    </li>
  );
  const toolbar = (
    <Toolbar
      prefs={prefs}
      setPrefs={setPrefs}
      filters={filters}
      setFilters={setFilters}
      directory={directory}
      status={status}
      onRefresh={() => setTick((t) => t + 1)}
    />
  );
  return (
    <section className="pg-workspace pg-wf pg-reports" aria-label="Reports">
      <div className="pg-area">
        <SideMenu state={menu} title="Reports" label="Reports menu">
          <nav aria-label="Reports">
            <ul className="pg-menu-entries">{entry("overview", "Overview")}</ul>
            {REPORT_GROUPS.map((g) => (
              <section key={g.name} className="pg-menu-section">
                <h2 className="pg-settings-group">{g.name}</h2>
                <ul className="pg-menu-entries">{g.reports.map((id) => entry(id, PREBUILT.find((r) => r.id === id)!.name))}</ul>
              </section>
            ))}
          </nav>
        </SideMenu>
        <div className="pg-area-main">
          {open && !report ? (
            <div className="pg-settings-body">
              <p className="pg-muted">There’s no such report.</p>
              <button type="button" className="pg-wf-link" onClick={() => onOpen(null)}>
                Back to the overview
              </button>
            </div>
          ) : report ? (
            <ReportPage key={report.id} report={report} query={query} range={range} toolbar={toolbar} menu={<ShowMenuButton state={menu} />} directory={directory} />
          ) : (
            <Overview query={query} range={range} toolbar={toolbar} menu={<ShowMenuButton state={menu} />} directory={directory} zoeName={zoeName} onOpen={onOpen} />
          )}
        </div>
      </div>
    </section>
  );
}

function Toolbar({
  prefs,
  setPrefs,
  filters,
  setFilters,
  directory,
  status,
  onRefresh,
}: {
  prefs: ReturnType<typeof savedPrefs>;
  setPrefs: (p: ReturnType<typeof savedPrefs>) => void;
  filters: Query["filters"];
  setFilters: (f: Query["filters"]) => void;
  directory: Directory;
  status: { asOf: string | null; conversations: number } | null;
  onRefresh: () => void;
}) {
  const allZones = useMemo(() => {
    const z = zones();
    return z.includes(prefs.timezone) ? z : [prefs.timezone, ...z];
  }, [prefs.timezone]);
  const today = ymd(new Date(), prefs.timezone);
  return (
    <div className="pg-rep-toolbar" role="toolbar" aria-label="Report period and filters">
      <div className="pg-rep-presets" role="radiogroup" aria-label="Period">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={prefs.range.preset === p.id}
            onClick={() =>
              setPrefs({
                ...prefs,
                range: p.id === "custom" ? { preset: "custom", from: prefs.range.from ?? ymd(new Date(Date.now() - 6 * 86_400_000), prefs.timezone), to: prefs.range.to ?? today } : { preset: p.id },
              })
            }
          >
            {p.label}
          </button>
        ))}
      </div>
      {prefs.range.preset === "custom" && (
        <span className="pg-rep-custom">
          <input type="date" aria-label="From" max={prefs.range.to ?? today} value={prefs.range.from ?? ""} onChange={(e) => setPrefs({ ...prefs, range: { ...prefs.range, from: e.target.value } })} />
          <span aria-hidden="true">–</span>
          <input type="date" aria-label="To" min={prefs.range.from} max={today} value={prefs.range.to ?? ""} onChange={(e) => setPrefs({ ...prefs, range: { ...prefs.range, to: e.target.value } })} />
        </span>
      )}
      <select aria-label="Channel" value={filters.channel ?? ""} onChange={(e) => setFilters({ ...filters, channel: e.target.value || undefined })}>
        <option value="">All channels</option>
        {Object.keys(CHANNEL_LABELS).map((c) => (
          <option key={c} value={c}>
            {channelLabel(c)}
          </option>
        ))}
      </select>
      {directory.teams.length > 0 && (
        <select aria-label="Team" value={filters.teamId ?? ""} onChange={(e) => setFilters({ ...filters, teamId: e.target.value || undefined })}>
          <option value="">All teams</option>
          {directory.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      <select aria-label="Timezone" value={prefs.timezone} onChange={(e) => setPrefs({ ...prefs, timezone: e.target.value })}>
        {allZones.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, " ")}
          </option>
        ))}
      </select>
      <label className="pg-rep-switch">
        <input type="checkbox" role="switch" checked={prefs.officeHours} onChange={(e) => setPrefs({ ...prefs, officeHours: e.target.checked })} />
        <span>Office hours</span>
      </label>
      <span className="pg-rep-fresh" aria-label="How current reports are">
        <Clock size={13} aria-hidden="true" />
        {status?.asOf ? `Updated ${ago(status.asOf)}` : "Not yet updated"}
        <button type="button" className="pg-wf-link" onClick={onRefresh}>
          Refresh
        </button>
      </span>
    </div>
  );
}
function ago(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Head({ title, description, menu, toolbar }: { title: string; description: string; menu: React.ReactNode; toolbar: React.ReactNode }) {
  return (
    <header className="pg-rep-head">
      <div className="pg-rep-title">
        {menu}
        <div>
          <h2>{title}</h2>
          <p className="pg-muted">{description}</p>
        </div>
      </div>
      {toolbar}
    </header>
  );
}

function ReportPage({
  report,
  query,
  range,
  toolbar,
  menu,
  directory,
}: {
  report: PrebuiltReport;
  query: Query;
  range: { from: Date; to: Date };
  toolbar: React.ReactNode;
  menu: React.ReactNode;
  directory: Directory;
}) {
  const charts = useMemo(() => report.charts.map((c) => ({ ...c, breakdown: granularity(c.breakdown, range.from, range.to) })), [report, range]);
  const answers = useAnswers(charts, query);
  const tiles = charts.map((c, i) => ({ c, i })).filter(({ c }) => !c.breakdown);
  const graphs = charts.map((c, i) => ({ c, i })).filter(({ c }) => c.breakdown);
  return (
    <>
      <Head title={report.name} description={report.description} menu={menu} toolbar={toolbar} />
      <div className="pg-rep-body">
        {tiles.length > 0 && (
          <div className="pg-rep-tiles">
            {tiles.map(({ c, i }) => (
              <Tile key={c.metric + i} chart={c} answer={answers.get(c)} query={query} hue={HUES[i % HUES.length]} onRetry={() => answers.retry(c)} />
            ))}
          </div>
        )}
        <div className="pg-rep-grid">
          {graphs.map(({ c, i }) => (
            <ChartCard key={c.metric + c.breakdown + i} chart={c} answer={answers.get(c)} query={query} range={range} hue={HUES[i % HUES.length]} directory={directory} onRetry={() => answers.retry(c)} />
          ))}
        </div>
      </div>
    </>
  );
}

function Overview({
  query,
  range,
  toolbar,
  menu,
  directory,
  zoeName,
  onOpen,
}: {
  query: Query;
  range: { from: Date; to: Date };
  toolbar: React.ReactNode;
  menu: React.ReactNode;
  directory: Directory;
  zoeName: string;
  onOpen: (id: string) => void;
}) {
  const overview = PREBUILT.find((r) => r.id === "overview")!;
  // The flow, kept with the question it answers: a new period shows the skeleton until its answer comes.
  const flowKey = JSON.stringify([query.from, query.to, query.filters]);
  const [answered, setAnswered] = useState<{ key: string; flow: Flow | { error: string } } | null>(null);
  useEffect(() => {
    let live = true;
    api<Flow>("report-flow", { from: query.from, to: query.to, filters: query.filters }).then(
      (f) => live && setAnswered({ key: flowKey, flow: f }),
      (e) => live && setAnswered({ key: flowKey, flow: { error: message(e, "The flow couldn't be loaded.") } }),
    );
    return () => {
      live = false;
    };
  }, [flowKey, query.from, query.to, query.filters]);
  const flow = answered?.key === flowKey ? answered.flow : null;
  const charts = useMemo(() => overview.charts.map((c) => ({ ...c, breakdown: granularity(c.breakdown, range.from, range.to) })), [overview, range]);
  const answers = useAnswers(charts, query);
  return (
    <>
      <Head title="Overview" description={`How your team and ${zoeName} handled conversations: volume, speed, resolution and satisfaction, against the period before.`} menu={menu} toolbar={toolbar} />
      <div className="pg-rep-body">
        <section className="pg-rep-card pg-rep-flowcard" aria-label="How conversations were handled">
          <h3>How conversations were handled</h3>
          {!flow ? <div className="pg-rep-skeleton tall" aria-busy="true" /> : "error" in flow ? <p className="pg-attr-error">{flow.error}</p> : <FlowChart flow={flow} zoeName={zoeName} />}
        </section>
        <div className="pg-rep-tiles">
          {charts
            .map((c, i) => ({ c, i }))
            .filter(({ c }) => !c.breakdown)
            .map(({ c, i }) => (
              <Tile key={c.metric} chart={c} answer={answers.get(c)} query={query} hue={HUES[i % HUES.length]} onRetry={() => answers.retry(c)} />
            ))}
        </div>
        <div className="pg-rep-grid">
          {charts
            .map((c, i) => ({ c, i }))
            .filter(({ c }) => c.breakdown)
            .map(({ c, i }) => (
              <ChartCard key={c.metric} chart={c} answer={answers.get(c)} query={query} range={range} hue={HUES[i % HUES.length]} directory={directory} onRetry={() => answers.retry(c)} wide />
            ))}
        </div>
        <section aria-label="All reports">
          <h3 className="pg-rep-section">All reports</h3>
          <div className="pg-rep-index">
            {REPORT_GROUPS.flatMap((g) =>
              g.reports.map((id) => {
                const r = PREBUILT.find((x) => x.id === id)!;
                return (
                  <button key={id} type="button" className="pg-rep-link" onClick={() => onOpen(id)}>
                    <span className="pg-rep-link-icon" aria-hidden="true">
                      {ICONS[id]}
                    </span>
                    <span className="pg-rep-link-text">
                      <span className="pg-rep-link-group">{g.name}</span>
                      <strong>{r.name}</strong>
                      <span className="pg-muted">{r.description}</span>
                    </span>
                    <ArrowRight size={15} aria-hidden="true" className="pg-rep-link-go" />
                  </button>
                );
              }),
            )}
          </div>
        </section>
      </div>
    </>
  );
}

/** What a metric counts, from the dictionary: the same words as docs/METRICS.md. */
function About({ m }: { m: Metric }) {
  return (
    <details className="pg-rep-about">
      <summary aria-label={`What ${m.name} counts`}>
        <Info size={13} aria-hidden="true" />
      </summary>
      <dl>
        <dt>Formula</dt>
        <dd>{m.formula}</dd>
        <dt>Counted at</dt>
        <dd>{m.anchor}</dd>
        <dt>Includes</dt>
        <dd>{m.includes}</dd>
        <dt>Excludes</dt>
        <dd>{m.excludes}</dd>
        <dt>Automation</dt>
        <dd>{m.automation}</dd>
      </dl>
    </details>
  );
}

function Tile({ chart, answer, query, hue, onRetry }: { chart: Chart; answer: Answer | { error: string } | undefined; query: Query; hue: string; onRetry: () => void }) {
  const m = definition(chart.metric)!;
  const delta = answer && !("error" in answer) ? change(chart.metric, answer.total, answer.previous, query.officeHours) : null;
  return (
    <section className="pg-rep-tile" data-hue={hue} aria-label={m.name}>
      <header>
        <h3>{m.name}</h3>
        <About m={m} />
      </header>
      {!answer ? (
        <div className="pg-rep-skeleton" aria-busy="true" />
      ) : "error" in answer ? (
        <p className="pg-attr-error">
          {answer.error}{" "}
          <button type="button" className="pg-wf-link" onClick={onRetry}>
            Try again
          </button>
        </p>
      ) : (
        <>
          <p className="pg-rep-value" data-testid="value">
            {fmtValue(answer.total, query.officeHours)}
            {answer.total.kind === "rate" && answer.total.value !== null && <small> per hour</small>}
          </p>
          <p className="pg-rep-detail">{detailOf(answer.total)}</p>
          {delta && (
            <p className="pg-rep-delta" data-tone={delta.tone} aria-label={`${delta.text} against the previous period`}>
              {delta.dir === "up" ? <ArrowUpRight size={13} aria-hidden="true" /> : delta.dir === "down" ? <ArrowDownRight size={13} aria-hidden="true" /> : <Minus size={13} aria-hidden="true" />}
              {delta.text}
              <span className="pg-muted"> vs {fmtValue(answer.previous, query.officeHours)} before</span>
            </p>
          )}
        </>
      )}
    </section>
  );
}

function ChartCard({
  chart,
  answer,
  query,
  range,
  hue,
  directory,
  onRetry,
  wide,
}: {
  chart: Chart;
  answer: Answer | { error: string } | undefined;
  query: Query;
  range: { from: Date; to: Date };
  hue: string;
  directory: Directory;
  onRetry: () => void;
  wide?: boolean;
}) {
  const m = definition(chart.metric)!;
  const by = chart.breakdown!;
  const byName = isTime(by) ? `by ${by}` : by === "item" ? "by item" : `by ${by}`;
  return (
    <section className={"pg-rep-card" + (wide ? " wide" : "")} data-hue={hue} aria-label={`${m.name} ${byName}`}>
      <header>
        <h3>
          {m.name} <span className="pg-muted">{byName}</span>
        </h3>
        {answer && !("error" in answer) && <span className="pg-rep-total">{fmtValue(answer.total, query.officeHours)}</span>}
        <About m={m} />
      </header>
      {!answer ? (
        <div className="pg-rep-skeleton tall" aria-busy="true" />
      ) : "error" in answer ? (
        <p className="pg-attr-error">
          {answer.error}{" "}
          <button type="button" className="pg-wf-link" onClick={onRetry}>
            Try again
          </button>
        </p>
      ) : isTime(by) ? (
        <TimeChart answer={answer} breakdown={by} query={query} range={range} name={m.name} />
      ) : (
        <BarList answer={answer} breakdown={by} query={query} directory={directory} />
      )}
    </section>
  );
}

/** Bars over time, every period present (quiet ones as gaps), with the hovered one read out. */
function TimeChart({ answer, breakdown, query, range, name }: { answer: Answer; breakdown: Breakdown; query: Query; range: { from: Date; to: Date }; name: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const keys = periodKeys(range.from, range.to, query.timezone, breakdown);
  const byKey = new Map(answer.rows.map((r) => [r.key, r.value]));
  const points = keys.map((k) => {
    const v = byKey.get(k);
    return { key: k, value: v ?? null, n: v ? numberOf(v, query.officeHours) : null };
  });
  const max = Math.max(0, ...points.map((p) => p.n ?? 0));
  const top = niceMax(max);
  const W = 640,
    H = 180,
    left = 44,
    bottom = 22;
  const step = (W - left) / Math.max(1, points.length);
  const bar = Math.max(1.5, Math.min(28, step * 0.68));
  const y = (n: number) => (H - bottom) * (1 - n / (top || 1));
  const fmtAxis = (n: number) => (answer.total.kind === "duration" ? fmtDuration(n) : answer.total.kind === "share" ? `${Math.round(n)}%` : fmtCount(Math.round(n)));
  const shown = hover !== null ? points[hover] : null;
  const best = points.reduce((b, p) => (p.n !== null && (b === null || p.n > (b.n ?? -1)) ? p : b), null as (typeof points)[number] | null);
  const every = Math.ceil(points.length / 6);
  if (!answer.rows.length) return <p className="pg-rep-empty">Nothing in this period.</p>;
  return (
    <figure className="pg-rep-time">
      <figcaption className="pg-rep-readout" aria-live="polite">
        {shown ? (
          <>
            <strong>{shown.value ? fmtValue(shown.value, query.officeHours) : answer.total.kind === "count" ? "0" : "None"}</strong> <span className="pg-muted">{periodLabel(shown.key, breakdown)}</span>
          </>
        ) : best ? (
          <span className="pg-muted">
            Highest: <strong>{best.value ? fmtValue(best.value, query.officeHours) : ""}</strong> on {periodLabel(best.key, breakdown)}
          </span>
        ) : null}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${name} by ${breakdown}${best ? `: highest ${best.value ? fmtValue(best.value, query.officeHours) : ""} on ${periodLabel(best.key, breakdown)}` : ""}`} onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="pg-rep-grid-line" x1={left} x2={W} y1={y(top * f)} y2={y(top * f)} />
            <text className="pg-rep-axis" x={left - 6} y={y(top * f) + 4} textAnchor="end">
              {fmtAxis(top * f)}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          const x = left + i * step + (step - bar) / 2;
          const h = p.n ? Math.max(2, (H - bottom) - y(p.n)) : 0;
          return (
            <g key={p.key} onMouseEnter={() => setHover(i)}>
              <rect className="pg-rep-hit" x={left + i * step} y={0} width={step} height={H - bottom} />
              {h > 0 && <rect className="pg-rep-bar" data-on={hover === i ? "true" : undefined} x={x} y={(H - bottom) - h} width={bar} height={h} rx={Math.min(4, bar / 3)} />}
              {i % every === 0 && (
                <text className="pg-rep-axis" x={left + i * step + step / 2} y={H - 6} textAnchor="middle">
                  {periodLabel(p.key, breakdown)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
function niceMax(n: number) {
  if (n <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  // Steps whose half is a whole number too, so the middle line reads cleanly.
  for (const m of [1, 2, 4, 6, 8, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

/** A breakdown by brand, channel, team, teammate or item: one bar per key, largest first. */
function BarList({ answer, breakdown, query, directory }: { answer: Answer; breakdown: Breakdown; query: Query; directory: Directory }) {
  const [all, setAll] = useState(false);
  const rows = answer.rows
    .map((r) => ({ label: labelOf(r.key, breakdown, answer, directory), value: r.value, n: numberOf(r.value, query.officeHours) ?? 0 }))
    .sort((a, b) => b.n - a.n);
  const max = Math.max(0, ...rows.map((r) => r.n));
  if (!rows.length) return <p className="pg-rep-empty">Nothing in this period.</p>;
  const shown = all ? rows : rows.slice(0, 8);
  return (
    <>
      <ul className="pg-rep-bars">
        {shown.map((r) => (
          <li key={r.label}>
            <span className="pg-rep-bar-label" title={r.label}>
              {r.label}
            </span>
            <span className="pg-rep-bar-track" aria-hidden="true">
              <span style={{ width: `${max ? Math.max(2, (r.n / max) * 100) : 0}%` }} />
            </span>
            <span className="pg-rep-bar-value">
              {fmtValue(r.value, query.officeHours)}
              {r.value.kind === "share" && <small> {fmtCount(r.value.numerator)}/{fmtCount(r.value.denominator)}</small>}
            </span>
          </li>
        ))}
      </ul>
      {rows.length > 8 && (
        <button type="button" className="pg-wf-link" onClick={() => setAll(!all)}>
          {all ? "Show the top 8" : `Show all ${rows.length}`}
        </button>
      )}
    </>
  );
}

/**
 * The overview's flow: every new conversation from the left, split by who handled it, then by how
 * it ended. Band widths are to scale; the server's parts always add up to the whole.
 */
function FlowChart({ flow, zoeName }: { flow: Flow; zoeName: string }) {
  const [hover, setHover] = useState<string | null>(null);
  if (!flow.total) return <p className="pg-rep-empty">No conversations started in this period.</p>;
  type Node = { id: string; label: string; n: number; tone: string; col: number; parent?: string };
  const nodes: Node[] = [
    { id: "all", label: "New conversations", n: flow.total, tone: "all", col: 0 },
    { id: "zoe", label: `${zoeName} involved`, n: flow.zoe.total, tone: "zoe", col: 1, parent: "all" },
    { id: "teammate", label: "Teammate replied", n: flow.teammate.total, tone: "teammate", col: 1, parent: "all" },
    { id: "noreply", label: "Closed without a reply", n: flow.closedWithoutReply, tone: "quiet", col: 1, parent: "all" },
    { id: "waiting", label: "Waiting for a reply", n: flow.waiting, tone: "waiting", col: 1, parent: "all" },
    { id: "resolved", label: `Resolved by ${zoeName}`, n: flow.zoe.resolved, tone: "good", col: 2, parent: "zoe" },
    { id: "handed", label: "Handed to a teammate", n: flow.zoe.handedOver, tone: "handed", col: 2, parent: "zoe" },
    { id: "zoeother", label: `${zoeName} only, not resolved`, n: flow.zoe.other, tone: "quiet", col: 2, parent: "zoe" },
    { id: "tclosed", label: "Closed by the team", n: flow.teammate.closed, tone: "good", col: 2, parent: "teammate" },
    { id: "topen", label: "Still open", n: flow.teammate.open, tone: "waiting", col: 2, parent: "teammate" },
  ].filter((n) => n.n > 0);
  const W = 900,
    H = 300,
    nodeW = 12,
    gap = 14;
  const xs = [8, 330, 620];
  // Each column stacks its nodes top to bottom, scaled so the whole fills the height less the gaps.
  const place = new Map<string, { y: number; h: number }>();
  for (const col of [0, 1, 2]) {
    const here = nodes.filter((n) => n.col === col);
    const scale = (H - gap * Math.max(0, here.length - 1)) / flow.total;
    let y = 0;
    for (const n of here) {
      const h = Math.max(3, n.n * (col === 0 ? H / flow.total : scale));
      place.set(n.id, { y, h });
      y += h + gap;
    }
  }
  // Bands leave each parent in child order, filling it from the top.
  const used = new Map<string, number>();
  const links = nodes
    .filter((n) => n.parent)
    .map((n) => {
      const p = place.get(n.parent!)!,
        c = place.get(n.id)!;
      const parent = nodes.find((x) => x.id === n.parent)!;
      const share = (n.n / parent.n) * p.h;
      const y0 = p.y + (used.get(n.parent!) ?? 0);
      used.set(n.parent!, (used.get(n.parent!) ?? 0) + share);
      const x0 = xs[parent.col] + nodeW,
        x1 = xs[n.col];
      const mid = (x0 + x1) / 2;
      const d = `M${x0},${y0} C${mid},${y0} ${mid},${c.y} ${x1},${c.y} L${x1},${c.y + c.h} C${mid},${c.y + c.h} ${mid},${y0 + share} ${x0},${y0 + share} Z`;
      return { id: n.id, parent: n.parent!, tone: n.tone, d };
    });
  const pct = (n: number) => `${Math.round((n / flow.total) * 100)}%`;
  const lit = (id: string) => !hover || hover === id || nodes.find((n) => n.id === hover)?.parent === id || nodes.find((n) => n.id === id)?.parent === hover;
  return (
    <div className="pg-rep-flow">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Of ${flow.total} new conversations: ${nodes.filter((n) => n.col > 0).map((n) => `${n.label} ${n.n}`).join(", ")}`}>
        {links.map((l) => (
          <path key={l.id} d={l.d} className="pg-rep-flow-link" data-tone={l.tone} data-dim={lit(l.id) ? undefined : "true"} onMouseEnter={() => setHover(l.id)} onMouseLeave={() => setHover(null)} />
        ))}
        {nodes.map((n) => {
          const p = place.get(n.id)!;
          const x = xs[n.col] + nodeW + 8;
          return (
            <g key={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} data-dim={lit(n.id) ? undefined : "true"} className="pg-rep-flow-node">
              <rect x={xs[n.col]} y={p.y} width={nodeW} height={p.h} rx={3} data-tone={n.tone} />
              <text x={x} y={p.y + Math.min(p.h / 2, 30) + 4} className="pg-rep-flow-label">
                <tspan className="pg-rep-flow-n">{fmtCount(n.n)}</tspan>
                <tspan className="pg-rep-flow-pct"> {pct(n.n)}</tspan>
                <tspan x={x} dy={15}>
                  {n.label}
                </tspan>
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
