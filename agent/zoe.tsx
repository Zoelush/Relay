import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  CheckCircle2,
  CircleHelp,
  FlaskConical,
  MessageCircle,
  MessageSquareQuote,
  Route,
  Send,
  Settings as SettingsIcon,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { api } from "./api";
import { ShowMenuButton, SideMenu, useSideMenu, type SideMenuState } from "./shell";
import { Card, Field, Frame, message, type Page } from "./settings-ui";
import { ZoeMark, type Hue } from "./colour";
import { ImageField } from "./messenger-assets";
import {
  AnsweringCard,
  GuidanceCard,
  HandoverCards,
  LanguagesCard,
  ResolutionsCard,
  Rules,
  TopicsCard,
  useAiSettings,
} from "./settings-ai";
import { GuidancePage, type PreviewResult } from "./zoe-guidance";
import {
  OUTCOME_HUES,
  OUTCOME_NAMES,
  TRIGGER_NAMES,
  ago,
  languageNote,
  voiceSummary,
} from "./zoe-labels";
import { languageName, type Voice } from "../lib/zoe-voice";

/**
 * Zoe, Relay's AI agent, in the agent app (phase 08, step Z1; docs/AI_STEP5.md). She has her own
 * place in the icon strip, between Inbox and Knowledge, and her own side menu, organised as Beacon
 * and Intercom organise their agents: Overview; Train (Guidance, Escalation, Content); Test
 * (Playground); Deploy (Messenger); Analyze (Performance, Knowledge gaps, Resolutions); Settings.
 * Z2 (docs/AI_STEP6.md) adds Train › Guidance (agent/zoe-guidance.tsx) and her languages.
 * TODO(phase 08 Z3): Train › Specialists. TODO(phase 08 C1): Test › Test suites.
 */
type PageId =
  | "overview"
  | "guidance"
  | "escalation"
  | "content"
  | "playground"
  | "messenger"
  | "performance"
  | "gaps"
  | "resolutions"
  | "settings";
const PAGES: {
  id: PageId;
  label: string;
  group: "" | "Train" | "Test" | "Deploy" | "Analyze";
  icon: LucideIcon;
  hue: Hue;
  description: string;
}[] = [
  {
    id: "overview",
    label: "Overview",
    group: "",
    icon: Sparkles,
    hue: "zoe",
    description: "",
  },
  {
    id: "guidance",
    label: "Guidance",
    group: "Train",
    icon: MessageSquareQuote,
    hue: "zoe",
    description:
      "How she sounds, and plain instructions for how she answers. Try your changes beside them before you save.",
  },
  {
    id: "escalation",
    label: "Escalation",
    group: "Train",
    icon: Route,
    hue: "violet",
    description:
      "When she hands a conversation to the team: rules, topics she never handles, guidance, and what happens next.",
  },
  {
    id: "content",
    label: "Content",
    group: "Train",
    icon: BookOpen,
    hue: "amber",
    description:
      "What she answers from: published knowledge switched on for the AI agent, and never internal content.",
  },
  {
    id: "playground",
    label: "Playground",
    group: "Test",
    icon: FlaskConical,
    hue: "sky",
    description:
      "Ask her anything a customer might, and see exactly what she'd say, how sure she is, and why.",
  },
  {
    id: "messenger",
    label: "Messenger",
    group: "Deploy",
    icon: MessageCircle,
    hue: "blue",
    description: "Where she answers: each brand's messenger, and as whom.",
  },
  {
    id: "performance",
    label: "Performance",
    group: "Analyze",
    icon: BarChart3,
    hue: "teal",
    description: "What she did over the last 30 days, and why.",
  },
  {
    id: "gaps",
    label: "Knowledge gaps",
    group: "Analyze",
    icon: CircleHelp,
    hue: "rose",
    description:
      "The questions she couldn't answer in the last 30 days, most asked first: the articles to write next.",
  },
  {
    id: "resolutions",
    label: "Resolutions",
    group: "Analyze",
    icon: CheckCircle2,
    hue: "green",
    description:
      "Every conversation she resolved, in a ledger that's never changed.",
  },
  {
    id: "settings",
    label: "Settings",
    group: "",
    icon: SettingsIcon,
    hue: "slate",
    description:
      "Her identity on each brand, when she answers, how sure she must be, and her languages.",
  },
];
const asPage = (p: (typeof PAGES)[number]): Page => ({
  id: p.id,
  label: p.label,
  description: p.description,
  icon: p.icon,
  group: p.group || "Zoe",
});
const SOURCE_NAMES: Record<string, string> = {
  article: "Articles",
  internal_article: "Internal articles",
  snippet: "Snippets",
  file: "Files",
  website: "Website pages",
};
export function Zoe({
  page,
  onPage,
  onName,
  onKnowledge,
  onMessenger,
}: {
  page: string;
  onPage: (page: string) => void;
  /** Her name changed (the default brand's identity): the app relabels her. */
  onName: (name: string) => void;
  onKnowledge: () => void;
  onMessenger: () => void;
}) {
  const menu = useSideMenu("zoe");
  const [agent, setAgent] = useState<{ name: string; enabled: boolean } | null>(
    null,
  );
  useEffect(() => {
    api<{ agent: { name: string; enabled: boolean } }>("zoe?view=overview")
      .then((o) => setAgent(o.agent))
      .catch(() => setAgent({ name: "Zoe", enabled: false }));
  }, []);
  const name = agent?.name ?? "Zoe";
  const current = PAGES.find((p) => p.id === page) ?? PAGES[0];
  const entry = (p: (typeof PAGES)[number]) => (
    <li key={p.id} data-hue={p.hue}>
      <button
        aria-current={current.id === p.id ? "page" : undefined}
        onClick={() => onPage(p.id)}
      >
        <span className="pg-menu-entry-icon" aria-hidden="true">
          <p.icon size={16} />
        </span>
        <span className="pg-menu-entry-name">{p.label}</span>
      </button>
    </li>
  );
  const props = {
    menu,
    name,
    onPage,
    agent,
    setAgent: (a: { name: string; enabled: boolean }) => {
      setAgent(a);
      onName(a.name);
    },
  };
  return (
    <section className="pg-workspace pg-zoe" aria-label={name}>
      <div className="pg-area">
        <SideMenu state={menu} title={`${name} AI agent`} label={`${name} menu`}>
          <div className="pg-zoe-id">
            <ZoeMark size={36} />
            <span>
              <strong>{name}</strong>
              <span
                className="pg-zoe-status"
                data-on={agent?.enabled ? "true" : "false"}
              >
                {agent?.enabled ? "Live" : "Off"}
              </span>
            </span>
          </div>
          <nav aria-label={`${name}'s pages`}>
            <ul className="pg-menu-entries">{entry(PAGES[0])}</ul>
            {(["Train", "Test", "Deploy", "Analyze"] as const).map((g) => (
              <section key={g} className="pg-menu-section">
                <h2 className="pg-settings-group">{g}</h2>
                <ul className="pg-menu-entries">
                  {PAGES.filter((p) => p.group === g).map(entry)}
                </ul>
              </section>
            ))}
            <ul className="pg-menu-entries pg-zoe-last">
              {entry(PAGES.find((p) => p.id === "settings")!)}
            </ul>
          </nav>
        </SideMenu>
        <div className="pg-area-main">
          {current.id === "overview" ? (
            <Overview {...props} />
          ) : current.id === "guidance" ? (
            <GuidancePage menu={menu} page={asPage(current)} name={name} />
          ) : current.id === "escalation" ? (
            <EscalationPage {...props} page={asPage(current)} />
          ) : current.id === "content" ? (
            <ContentPage
              {...props}
              page={asPage(current)}
              onKnowledge={onKnowledge}
            />
          ) : current.id === "playground" ? (
            <Playground {...props} page={asPage(current)} />
          ) : current.id === "messenger" ? (
            <DeployPage
              {...props}
              page={asPage(current)}
              onMessenger={onMessenger}
            />
          ) : current.id === "performance" ? (
            <PerformancePage {...props} page={asPage(current)} />
          ) : current.id === "gaps" ? (
            <GapsPage {...props} page={asPage(current)} />
          ) : current.id === "resolutions" ? (
            <ResolutionsPage {...props} page={asPage(current)} />
          ) : (
            <SettingsPage {...props} page={asPage(current)} />
          )}
        </div>
      </div>
    </section>
  );
}

type PageProps = {
  menu: SideMenuState;
  name: string;
  onPage: (page: string) => void;
  agent: { name: string; enabled: boolean } | null;
  setAgent: (a: { name: string; enabled: boolean }) => void;
};

/** Loads one of Zoe's views, with its error. */
function useView<T>(view: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api<T>("zoe?view=" + view)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(message(e, "This page could not be loaded.")));
    return () => {
      live = false;
    };
  }, [view, tick]);
  return { data, error, reload: () => setTick((n) => n + 1) };
}

/* ------------------------------------------------------------------------------------------ */
/* Overview                                                                                    */

type OverviewData = {
  agent: { name: string; enabled: boolean };
  days: number;
  stats: {
    resolutionRate: number | null;
    resolutions: number;
    involved: number;
    answers: number;
    handovers: number;
    confidence: number | null;
  };
  escalation: { rules: number; topics: number; guidance: number };
  voice: Voice & { guidelines: number; version: number; languages: number };
  content: number;
  gaps: { question: string; count: number; lastAt: string; conversationId: string }[];
  articles: { recordId: string; title: string; count: number }[];
};

function Overview({ menu, name, onPage, agent, setAgent }: PageProps) {
  const { data, error } = useView<OverviewData>("overview");
  const ai = useAiSettings();
  const enabled = ai.form?.enabled ?? agent?.enabled ?? false;
  const s = data?.stats;
  const plural = (n: number, one: string, many = one + "s") =>
    `${n} ${n === 1 ? one : many}`;
  return (
    <div className="pg-settings-page pg-zoe-page" role="region" aria-label="Overview">
      <header className="pg-top pg-settings-head pg-zoe-head">
        <ShowMenuButton state={menu} />
        <ZoeMark size={44} />
        <div>
          <h2>
            {name}{" "}
            <span className="pg-zoe-status" data-on={enabled ? "true" : "false"}>
              {enabled ? "Live" : "Off"}
            </span>
          </h2>
          <p className="pg-muted">
            Your AI agent answers customers from your knowledge, and hands
            over when she can&apos;t.
          </p>
        </div>
        <label className="pg-zoe-switch">
          <span>Answering customers</span>
          <input
            type="checkbox"
            role="switch"
            aria-checked={enabled}
            checked={enabled}
            disabled={!ai.form || ai.busy}
            onChange={async (e) => {
              const on = e.target.checked;
              await ai.save({ enabled: on });
              setAgent({ name, enabled: on });
            }}
          />
        </label>
      </header>
      <div className="pg-settings-body pg-zoe-body">
        {(error || ai.error) && (
          <p role="alert" className="pg-attr-error">
            {error || ai.error}
          </p>
        )}
        {data && s && (
          <>
            <div className="pg-zoe-stats" aria-label={`Last ${data.days} days`}>
              <Stat
                featured
                label="Resolution rate"
                value={s.resolutionRate === null ? "—" : `${s.resolutionRate}%`}
                hint={`${plural(s.resolutions, "resolution")} of ${plural(s.involved, "conversation")}`}
              />
              <Stat
                label="Answers"
                value={String(s.answers)}
                hint={`Last ${data.days} days`}
              />
              <Stat
                label="Handovers"
                value={String(s.handovers)}
                hint="Handed to your team"
              />
              <Stat
                label="Average confidence"
                value={s.confidence === null ? "—" : `${s.confidence}%`}
                hint="How well her best passage matched"
              />
            </div>
            <div className="pg-zoe-cards">
              <ActionCard
                hue="zoe"
                icon={MessageSquareQuote}
                title="Guidance"
                onClick={() => onPage("guidance")}
              >
                How she sounds, and plain instructions for how she answers.
                <small>
                  {voiceSummary(data.voice)} · {plural(data.voice.guidelines, "guideline")} on
                </small>
              </ActionCard>
              <ActionCard
                hue="violet"
                icon={Route}
                title="Escalation"
                onClick={() => onPage("escalation")}
              >
                When a person should take over: rules, topics she never
                handles, and guidance.
                <small>
                  {plural(data.escalation.rules, "rule")} ·{" "}
                  {plural(data.escalation.topics, "topic")} ·{" "}
                  {plural(data.escalation.guidance, "piece", "pieces")} of
                  guidance
                </small>
              </ActionCard>
              <ActionCard
                hue="amber"
                icon={BookOpen}
                title="Content"
                onClick={() => onPage("content")}
              >
                The published knowledge she answers from, never internal
                content.
                <small>{plural(data.content, "item")} she can use</small>
              </ActionCard>
              <ActionCard
                hue="sky"
                icon={FlaskConical}
                title="Playground"
                onClick={() => onPage("playground")}
              >
                Ask her what a customer would, and see the answer, her
                confidence and her sources.
                <small>Nothing reaches a customer</small>
              </ActionCard>
            </div>
            <div className="pg-zoe-panels">
              <section className="pg-zoe-panel" aria-labelledby="zoe-gaps">
                <header>
                  <h3 id="zoe-gaps">
                    <CircleHelp size={16} aria-hidden="true" /> Knowledge gaps
                  </h3>
                  <button type="button" className="pg-link-button" onClick={() => onPage("gaps")}>
                    All <ArrowRight size={13} aria-hidden="true" />
                  </button>
                </header>
                <p className="pg-muted">Questions she couldn&apos;t answer.</p>
                {data.gaps.length ? (
                  <ul aria-label="Knowledge gaps">
                    {data.gaps.map((g, i) => (
                      <li key={i}>
                        <span>{g.question}</span>
                        <span className="pg-zoe-count">{g.count}×</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="pg-zoe-empty">None in the last {data.days} days.</p>
                )}
              </section>
              <section className="pg-zoe-panel" aria-labelledby="zoe-articles">
                <header>
                  <h3 id="zoe-articles">
                    <BookOpen size={16} aria-hidden="true" /> Most-used articles
                  </h3>
                </header>
                <p className="pg-muted">What she leans on most.</p>
                {data.articles.length ? (
                  <ol aria-label="Most-used articles">
                    {data.articles.map((a) => (
                      <li key={a.recordId}>
                        <span>{a.title}</span>
                        <span className="pg-zoe-count">{a.count}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="pg-zoe-empty">
                    She hasn&apos;t answered from an article yet.
                  </p>
                )}
              </section>
            </div>
            <section className="pg-zoe-banner" aria-label={`Try ${name} yourself`}>
              <ZoeMark size={38} />
              <span>
                <strong>Try {name} yourself</strong>
                <small>
                  Ask her anything a customer might ask, and see the answer,
                  her confidence and the sources she used.
                </small>
              </span>
              <button
                type="button"
                className="pg-zoe-primary"
                onClick={() => onPage("playground")}
              >
                Open the playground <ArrowRight size={14} aria-hidden="true" />
              </button>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  featured,
}: {
  label: string;
  value: string;
  hint: string;
  featured?: boolean;
}) {
  return (
    <div className={"pg-zoe-stat" + (featured ? " featured" : "")}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}

function ActionCard({
  hue,
  icon: Icon,
  title,
  onClick,
  children,
}: {
  hue: Hue;
  icon: LucideIcon;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="pg-zoe-action" data-hue={hue} onClick={onClick}>
      <span className="pg-settings-tile-icon" aria-hidden="true">
        <Icon size={18} />
      </span>
      <strong>{title}</strong>
      <span className="pg-zoe-action-text">{children}</span>
    </button>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Train › Escalation, Analyze › Resolutions, Settings: the agent's settings, saved together   */

function EscalationPage({ menu, page }: PageProps & { page: Page }) {
  const ai = useAiSettings();
  return (
    <Frame
      menu={menu}
      page={page}
      save={{
        dirty: ai.dirty,
        busy: ai.busy,
        saved: ai.saved,
        error: ai.error,
        onSave: () => void ai.save(),
      }}
    >
      {ai.form && ai.data && (
        <>
          <HandoverCards form={ai.form} set={ai.set} data={ai.data} />
          <Rules
            rules={ai.form.rules}
            choices={ai.data.choices}
            onChange={(rules) => ai.set({ rules })}
          />
          <TopicsCard form={ai.form} set={ai.set} />
          <GuidanceCard form={ai.form} set={ai.set} />
        </>
      )}
    </Frame>
  );
}

function ResolutionsPage({ menu, page }: PageProps & { page: Page }) {
  const ai = useAiSettings();
  return (
    <Frame
      menu={menu}
      page={page}
      save={{
        dirty: ai.dirty,
        busy: ai.busy,
        saved: ai.saved,
        error: ai.error,
        onSave: () => void ai.save(),
      }}
    >
      {ai.form && ai.data && (
        <ResolutionsCard form={ai.form} set={ai.set} data={ai.data} />
      )}
    </Frame>
  );
}

type IdentityRow = {
  brandId: string;
  brandName: string;
  name: string;
  avatar: string;
  avatarDark: string;
  disclosure: string;
  greeting: string;
};

function SettingsPage({ menu, page, setAgent, agent }: PageProps & { page: Page }) {
  const ai = useAiSettings();
  const identities = ai.data?.identities ?? [];
  return (
    <Frame
      menu={menu}
      page={page}
      save={{
        dirty: ai.dirty,
        busy: ai.busy,
        saved: ai.saved,
        error: ai.error,
        onSave: () => void ai.save(),
      }}
    >
      {ai.form && ai.data && (
        <>
          <AnsweringCard form={ai.form} set={ai.set} />
          <LanguagesCard form={ai.form} set={ai.set} />
          {identities.map((i) => (
            <IdentityCard
              key={i.brandId}
              identity={i}
              onSaved={(next) => {
                if (next.brandId === "default")
                  setAgent({ name: next.name, enabled: agent?.enabled ?? true });
              }}
            />
          ))}
        </>
      )}
    </Frame>
  );
}

/** Zoe's identity on one brand: saved on its own (it isn't part of the versioned settings). */
function IdentityCard({
  identity,
  onSaved,
}: {
  identity: IdentityRow;
  onSaved: (i: IdentityRow) => void;
}) {
  const [form, setForm] = useState(identity);
  const [state, setState] = useState("");
  const [error, setError] = useState("");
  const dirty = JSON.stringify(form) !== JSON.stringify(identity);
  const set = (c: Partial<IdentityRow>) => {
    setState("");
    setForm({ ...form, ...c });
  };
  return (
    <Card
      title={`Identity on ${identity.brandName}`}
      description="Her name and avatar on her replies in this brand's messenger, a line telling customers she's an AI, and her reply to a greeting in the brand's language."
    >
      <div className="pg-zoe-identity">
        <span className="pg-zoe-preview" aria-hidden="true">
          <ZoeMark size={40} />
          <span>
            <strong>{form.name || "Zoe"}</strong>
            <small>AI agent</small>
          </span>
        </span>
        <Field label={`Name on ${identity.brandName}`}>
          {(id) => (
            <input
              id={id}
              maxLength={40}
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          )}
        </Field>
      </div>
      <Field
        label={`AI disclosure on ${identity.brandName}`}
        hint="Shown above her first reply in a conversation, so customers always know they're talking to an AI. Empty: the label “AI agent” beside her name says so."
      >
        {(id, hint) => (
          <input
            id={id}
            aria-describedby={hint}
            maxLength={200}
            placeholder="I'm Zoe, an AI agent. I'll bring in the team when I can't help."
            value={form.disclosure}
            onChange={(e) => set({ disclosure: e.target.value })}
          />
        )}
      </Field>
      <Field
        label={`Greeting on ${identity.brandName}`}
        hint="Her reply when a customer just says hello, in the brand's language. Other languages get the built-in translation."
      >
        {(id, hint) => (
          <textarea
            id={id}
            aria-describedby={hint}
            rows={2}
            maxLength={300}
            placeholder="Hi! What can I help you with?"
            value={form.greeting}
            onChange={(e) => set({ greeting: e.target.value })}
          />
        )}
      </Field>
      <div className="pg-settings-row">
        <ImageField
          label={`Avatar on ${identity.brandName}`}
          hint="In the light messenger. Square, PNG, JPG or GIF up to 1 MB. Without one, her mark takes the brand's colour."
          brandId={identity.brandId}
          purpose="agent_avatar"
          value={form.avatar}
          onChange={(v) => set({ avatar: v })}
        />
        <ImageField
          label={`Dark-theme avatar on ${identity.brandName}`}
          hint="In the dark messenger; without one, the light avatar is used."
          brandId={identity.brandId}
          purpose="agent_avatar_dark"
          value={form.avatarDark}
          onChange={(v) => set({ avatarDark: v })}
        />
      </div>
      <div className="pg-settings-row">
        <button
          type="button"
          className="pg-primary"
          disabled={!dirty || state === "Saving…"}
          onClick={async () => {
            setError("");
            setState("Saving…");
            try {
              const next = await api<IdentityRow>("zoe-identity", {
                brandId: identity.brandId,
                name: form.name,
                avatar: form.avatar,
                avatarDark: form.avatarDark,
                disclosure: form.disclosure,
                greeting: form.greeting,
              });
              const saved = { ...next, brandName: identity.brandName };
              setForm(saved);
              onSaved(saved);
              setState("Saved");
            } catch (e) {
              setState("");
              setError(message(e, "Her identity could not be saved."));
            }
          }}
        >
          Save identity on {identity.brandName}
        </button>
        <span role="status" className="pg-muted">
          {state}
        </span>
      </div>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Train › Content                                                                             */

type ContentData = {
  days: number;
  total: number;
  bySource: Record<string, number>;
  signedInOnly: number;
  excluded: { switchedOff: number; internal: number };
  records: {
    recordId: string;
    title: string;
    source: string;
    audience: string;
    locales: string[];
    used: number;
  }[];
};

function ContentPage({
  menu,
  page,
  onKnowledge,
}: PageProps & { page: Page; onKnowledge: () => void }) {
  const { data, error } = useView<ContentData>("content");
  const [query, setQuery] = useState("");
  const shown =
    data?.records.filter((r) =>
      r.title.toLowerCase().includes(query.trim().toLowerCase()),
    ) ?? [];
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {data && (
        <>
          <div className="pg-zoe-stats">
            <Stat
              featured
              label="She can use"
              value={String(data.total)}
              hint={Object.entries(data.bySource)
                .map(([k, v]) => `${v} ${(SOURCE_NAMES[k] ?? k).toLowerCase()}`)
                .join(" · ") || "Nothing yet"}
            />
            <Stat
              label="Signed-in customers only"
              value={String(data.signedInOnly)}
              hint="Used only for verified customers"
            />
            <Stat
              label="Switched off for AI"
              value={String(data.excluded.switchedOff)}
              hint="Never used, by your choice"
            />
            <Stat
              label="Internal"
              value={String(data.excluded.internal)}
              hint="Never shown to customers"
            />
          </div>
          <Card
            title="Content she answers from"
            description="Published in at least one language and switched on for the AI agent. She uses an item only for customers who may see it, in the first language along their chain."
          >
            <div className="pg-settings-row">
              <input
                aria-label="Search her content"
                placeholder="Search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button type="button" onClick={onKnowledge}>
                Manage in Knowledge <ArrowRight size={13} aria-hidden="true" />
              </button>
            </div>
            <ul className="pg-settings-list pg-zoe-content" aria-label="Content she can use">
              {shown.map((r) => (
                <li key={r.recordId}>
                  <span>
                    <strong>{r.title}</strong>
                    <small className="pg-muted">
                      {SOURCE_NAMES[r.source] ?? r.source} ·{" "}
                      {r.audience === "signed_in" ? "Signed-in customers" : "Everyone"} ·{" "}
                      {r.locales.join(", ")}
                    </small>
                  </span>
                  <span className="pg-zoe-count" title={`Cited in ${r.used} answers in the last ${data.days} days`}>
                    {r.used} {r.used === 1 ? "answer" : "answers"}
                  </span>
                </li>
              ))}
              {!shown.length && <li className="pg-zoe-empty">Nothing matches.</li>}
            </ul>
          </Card>
        </>
      )}
    </Frame>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Test › Playground                                                                           */

type Preview = PreviewResult;

function Playground({ menu, page, name }: PageProps & { page: Page }) {
  const [brands, setBrands] = useState<{ brandId: string; brandName: string }[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [brandId, setBrandId] = useState("default");
  const [signedIn, setSignedIn] = useState(false);
  const [locale, setLocale] = useState("");
  const [email, setEmail] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<(Preview & { asked: string }) | null>(null);
  useEffect(() => {
    api<{ brands: { brandId: string; brandName: string }[] }>("zoe?view=deploy")
      .then((d) => setBrands(d.brands))
      .catch(() => setBrands([]));
    api<OverviewData>("zoe?view=overview")
      .then((o) =>
        setSuggestions(
          [
            ...o.articles.slice(0, 3).map((a) => `How does ${a.title.toLowerCase()} work?`),
            ...o.gaps.slice(0, 2).map((g) => g.question),
          ].slice(0, 4),
        ),
      )
      .catch(() => setSuggestions([]));
  }, []);
  async function ask(text = question) {
    const q = text.trim();
    if (!q) return;
    setQuestion(q);
    setBusy(true);
    setError("");
    try {
      const r = await api<Preview>("zoe-playground", {
        question: q,
        brandId,
        signedIn,
        locale: locale || undefined,
        email: signedIn ? email : undefined,
        page: pageUrl || undefined,
      });
      setResult({ ...r, asked: q });
    } catch (e) {
      setError(message(e, "She couldn't be asked just now."));
    } finally {
      setBusy(false);
    }
  }
  const tone = (result && OUTCOME_HUES[result.outcome]) ?? "amber";
  return (
    <Frame menu={menu} page={page} wide>
      <div className="pg-zoe-playground">
        <form
          className="pg-zoe-ask"
          aria-label="Ask a question"
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
        >
          <Card
            title="As a customer would"
            description="Nothing is sent to a customer or recorded. Once Relay is deployed, each question is a real model call."
          >
            <div className="pg-settings-row">
              <Field label="Brand">
                {(id) => (
                  <select id={id} value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                    {(brands.length ? brands : [{ brandId: "default", brandName: "Default" }]).map((b) => (
                      <option key={b.brandId} value={b.brandId}>
                        {b.brandName}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Customer">
                {(id) => (
                  <select
                    id={id}
                    value={signedIn ? "user" : "visitor"}
                    onChange={(e) => setSignedIn(e.target.value === "user")}
                  >
                    <option value="visitor">A visitor</option>
                    <option value="user">A signed-in customer</option>
                  </select>
                )}
              </Field>
              <Field label="Browser language">
                {(id) => (
                  <input
                    id={id}
                    placeholder="None"
                    size={8}
                    title="Used when she can't tell the language from the question itself"
                    value={locale}
                    onChange={(e) => setLocale(e.target.value.trim())}
                  />
                )}
              </Field>
            </div>
            {signedIn && (
              <Field label="Their email" hint="For escalation rules on email domains.">
                {(id, hint) => (
                  <input
                    id={id}
                    aria-describedby={hint}
                    type="email"
                    placeholder="ada@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                )}
              </Field>
            )}
            <Field label="Page they're on" hint="For escalation rules on page addresses.">
              {(id, hint) => (
                <input
                  id={id}
                  aria-describedby={hint}
                  placeholder="https://example.com/pricing"
                  value={pageUrl}
                  onChange={(e) => setPageUrl(e.target.value)}
                />
              )}
            </Field>
          </Card>
          {!!suggestions.length && (
            <ul className="pg-zoe-suggestions" aria-label="Try one of these">
              {suggestions.map((s) => (
                <li key={s}>
                  <button type="button" disabled={busy} onClick={() => void ask(s)}>
                    <Sparkles size={13} aria-hidden="true" /> {s}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="pg-zoe-askbar">
            <textarea
              aria-label="Question"
              rows={2}
              maxLength={2000}
              placeholder={`Ask ${name} a customer question`}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void ask();
                }
              }}
            />
            <button type="submit" className="pg-zoe-primary" disabled={busy || !question.trim()}>
              <Send size={14} aria-hidden="true" /> {busy ? "Asking…" : "Ask"}
            </button>
          </div>
          {error && (
            <p role="alert" className="pg-attr-error">
              {error}
            </p>
          )}
        </form>
        <section className="pg-zoe-result" aria-label={`${name}'s reply`} aria-live="polite">
          {!result ? (
            <div className="pg-zoe-empty-state">
              <ZoeMark size={44} />
              <strong>Try a customer question</strong>
              <p className="pg-muted">
                {name} answers only from your published knowledge. If she
                can&apos;t, she says so and offers a person.
              </p>
            </div>
          ) : (
            <>
              <p className="pg-zoe-asked">
                <span className="pg-muted">Customer:</span> {result.asked}
              </p>
              <article className="pg-zoe-bubble">
                <header>
                  <ZoeMark size={22} />
                  <strong>{name}</strong>
                  <span className="pg-zoe-badge">AI agent</span>
                </header>
                <p>
                  {result.outcome === "ignored"
                    ? `She wouldn't reply. ${result.reason}`
                    : result.reply}
                </p>
                {!!result.sources.length && (
                  <ul aria-label="Sources">
                    {result.sources.map((s) => (
                      <li key={s.title}>{s.title}</li>
                    ))}
                  </ul>
                )}
                {!!result.options.length && (
                  <p className="pg-muted">Buttons: {result.options.join(" · ")}</p>
                )}
              </article>
              <dl className="pg-zoe-why" data-hue={tone}>
                <dt>Outcome</dt>
                <dd>
                  <span className="pg-zoe-outcome">{OUTCOME_NAMES[result.outcome] ?? result.outcome}</span>
                  {result.trigger && ` · ${TRIGGER_NAMES[result.trigger] ?? result.trigger}`}
                </dd>
                <dt>Why</dt>
                <dd>{result.reason}</dd>
                <dt>Confidence</dt>
                <dd>
                  {result.confidence === null ? (
                    "No passage she may use matched"
                  ) : (
                    <span className="pg-zoe-meter">
                      <span
                        className="pg-zoe-meter-bar"
                        role="meter"
                        aria-label="Confidence"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(result.confidence * 100)}
                      >
                        <span style={{ width: `${Math.round(result.confidence * 100)}%` }} />
                        <i style={{ left: `${Math.round(result.threshold * 100)}%` }} aria-hidden="true" />
                      </span>
                      {Math.round(result.confidence * 100)}% (answers need{" "}
                      {Math.round(result.threshold * 100)}%)
                    </span>
                  )}
                </dd>
                <dt>Language</dt>
                <dd>
                  {languageNote(result.language, result.customerLanguage, result.languageSource)}
                </dd>
                <dt>Voice</dt>
                <dd>
                  {voiceSummary(result.voice)} ·{" "}
                  {result.draft
                    ? "unsaved changes"
                    : result.guidanceVersion
                      ? `guidance version ${result.guidanceVersion}`
                      : "no guidance saved yet"}
                </dd>
                <dt>Model</dt>
                <dd>
                  {result.model ?? "None (not asked)"} · {result.latencyMs} ms
                </dd>
              </dl>
              <Card
                title="What she was told"
                description="The lines her voice and guidance add to her instructions, under her rules. Change them on the Guidance page."
              >
                <ul className="pg-zoe-told-list" aria-label="What she was told">
                  {result.instructions.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </Card>
              {!!result.candidates.length && (
                <Card
                  title="Passages she weighed"
                  description="Best match first. The ones marked were given to her to answer from; her sources above are the ones she cited."
                >
                  <ul className="pg-settings-list" aria-label="Passages she weighed">
                    {result.candidates.map((c, i) => (
                      <li key={i}>
                        <span>
                          <strong>{c.title}</strong>
                          {c.heading && <small className="pg-muted">{c.heading}</small>}
                        </span>
                        <span className="pg-zoe-count">
                          {c.score === null ? "—" : `${Math.round(c.score * 100)}%`}
                          {c.used ? " · given to her" : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </>
          )}
        </section>
      </div>
    </Frame>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Deploy › Messenger                                                                          */

function DeployPage({
  menu,
  page,
  onMessenger,
}: PageProps & { page: Page; onMessenger: () => void }) {
  const { data, error } = useView<{
    enabled: boolean;
    brands: {
      brandId: string;
      brandName: string;
      liveVersion: number | null;
      websitesSeen: number;
      identity: string;
    }[];
  }>("deploy");
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {data && (
        <Card
          title="Messenger"
          description={
            data.enabled
              ? "She answers in every brand's messenger, on the websites where it's installed."
              : "She's off: conversations go straight to the team. Turn her on in Overview."
          }
        >
          <ul className="pg-settings-list" aria-label="Brands">
            {data.brands.map((b) => (
              <li key={b.brandId}>
                <span>
                  <strong>
                    {b.brandName} · as {b.identity}
                  </strong>
                  <small className="pg-muted">
                    {b.liveVersion ? `Messenger version ${b.liveVersion} live` : "Messenger as first set up"} ·{" "}
                    {b.websitesSeen
                      ? `seen on ${b.websitesSeen} ${b.websitesSeen === 1 ? "website" : "websites"} this week`
                      : "not seen on a website this week"}
                  </small>
                </span>
                <span className="pg-zoe-status" data-on={data.enabled ? "true" : "false"}>
                  {data.enabled ? "Live" : "Off"}
                </span>
              </li>
            ))}
          </ul>
          <div>
            <button type="button" onClick={onMessenger}>
              Open Messenger settings <ArrowRight size={13} aria-hidden="true" />
            </button>
          </div>
        </Card>
      )}
    </Frame>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Analyze › Performance and Knowledge gaps                                                    */

type PerformanceData = {
  days: number;
  outcomes: Record<string, number>;
  triggers: { trigger: string; count: number }[];
  languages: { language: string; count: number }[];
  resolutions: { confirmed: number; quiet: number; reversals: number; net: number };
  medianLatencyMs: number | null;
  confidence: number | null;
};

function PerformancePage({ menu, page }: PageProps & { page: Page }) {
  const { data, error } = useView<PerformanceData>("performance");
  const total = data ? Object.values(data.outcomes).reduce((a, b) => a + b, 0) : 0;
  const bar = (n: number, of: number) => `${of ? Math.max(2, Math.round((n / of) * 100)) : 0}%`;
  const handovers = data?.triggers.reduce((a, t) => a + t.count, 0) ?? 0;
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {data && (
        <>
          <div className="pg-zoe-stats">
            <Stat featured label="Resolved" value={String(data.resolutions.net)} hint={`${data.resolutions.confirmed} confirmed · ${data.resolutions.quiet} quiet · ${data.resolutions.reversals} reversed`} />
            <Stat label="Messages considered" value={String(total)} hint={`Last ${data.days} days`} />
            <Stat label="Median time to answer" value={data.medianLatencyMs === null ? "—" : `${(data.medianLatencyMs / 1000).toFixed(1)}s`} hint="From the customer's message" />
            <Stat label="Average confidence" value={data.confidence === null ? "—" : `${data.confidence}%`} hint="Her best passage's match" />
          </div>
          <Card title="What she did" description="Every customer message she considered, by outcome.">
            <ul className="pg-zoe-bars" aria-label="Outcomes">
              {["answered", "clarified", "unknown", "failed", "escalated", "spam", "skipped"].map((k) => (
                <li key={k} data-hue={OUTCOME_HUES[k] ?? "amber"}>
                  <span>{OUTCOME_NAMES[k]}</span>
                  <span className="pg-zoe-bar"><span style={{ width: bar(data.outcomes[k] ?? 0, total) }} /></span>
                  <strong>{data.outcomes[k] ?? 0}</strong>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Languages she replied in" description="Each reply's language: what the customer wrote in, or the brand's when it isn't one of hers.">
            {data.languages.length ? (
              <ul className="pg-zoe-bars" aria-label="Languages">
                {data.languages.map((l) => (
                  <li key={l.language} data-hue="teal">
                    <span>{languageName(l.language)}</span>
                    <span className="pg-zoe-bar"><span style={{ width: bar(l.count, data.languages.reduce((a, x) => a + x.count, 0)) }} /></span>
                    <strong>{l.count}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pg-zoe-empty">No replies in the last {data.days} days.</p>
            )}
          </Card>
          <Card title="Why she handed over" description="The trigger behind each handover.">
            {data.triggers.length ? (
              <ul className="pg-zoe-bars" aria-label="Handover triggers">
                {data.triggers.map((t) => (
                  <li key={t.trigger} data-hue="violet">
                    <span>{TRIGGER_NAMES[t.trigger] ?? t.trigger}</span>
                    <span className="pg-zoe-bar"><span style={{ width: bar(t.count, handovers) }} /></span>
                    <strong>{t.count}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pg-zoe-empty">No handovers in the last {data.days} days.</p>
            )}
          </Card>
        </>
      )}
    </Frame>
  );
}

function GapsPage({ menu, page }: PageProps & { page: Page }) {
  const { data, error } = useView<{ days: number; gaps: OverviewData["gaps"] }>("gaps");
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {data && (
        <Card
          title={`${data.gaps.length} ${data.gaps.length === 1 ? "question" : "questions"} she couldn't answer`}
          description="The same question asked again counts once, with how often. Write or improve an article for the top ones, then try them in the Playground."
        >
          {data.gaps.length ? (
            <ul className="pg-settings-list" aria-label="Knowledge gaps">
              {data.gaps.map((g, i) => (
                <li key={i}>
                  <span>
                    <strong>{g.question}</strong>
                    <small className="pg-muted">
                      Last asked {ago(g.lastAt)} · conversation {g.conversationId}
                    </small>
                  </span>
                  <span className="pg-zoe-count">{g.count}×</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pg-zoe-empty">None in the last {data.days} days.</p>
          )}
        </Card>
      )}
    </Frame>
  );
}
