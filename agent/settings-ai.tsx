import { useEffect, useState } from "react";
import { api } from "./api";
import { Card, Field, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › AI agent (phase 08 A2a; docs/AI_STEP2.md): when the agent answers and how it hands
 * conversations to the team. Escalation rules, never-handle topics and guidance arrive in A2b;
 * several agents, identity and content targeting in B1.
 */
type Settings = {
  agent: {
    id: string;
    name: string;
    enabled: boolean;
    handoverTeamId: string | null;
    answerHours: "always" | "outside_office_hours";
    outOfHours: "continue" | "take_message" | "reply_time";
    failedLimit: number;
    escalateOnSentiment: boolean;
    version: string;
  };
  teams: { id: string; name: string }[];
};
type Form = Omit<Settings["agent"], "id" | "name" | "version">;
const formOf = (s: Settings): Form => ({
  enabled: s.agent.enabled,
  handoverTeamId: s.agent.handoverTeamId,
  answerHours: s.agent.answerHours,
  outOfHours: s.agent.outOfHours,
  failedLimit: s.agent.failedLimit,
  escalateOnSentiment: s.agent.escalateOnSentiment,
});

export function AiAgentPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Settings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Settings>("ai-settings")
      .then((s) => {
        setData(s);
        setForm(formOf(s));
      })
      .catch((e) => setError(message(e, "This page could not be loaded.")));
  }, []);
  const dirty =
    !!data && !!form && JSON.stringify(form) !== JSON.stringify(formOf(data));
  const set = (change: Partial<Form>) => {
    setSaved(false);
    setForm(form && { ...form, ...change });
  };
  async function save() {
    if (!data || !form) return;
    setBusy(true);
    setError("");
    try {
      const next = await api<Settings>("ai-settings", {
        ...form,
        version: data.agent.version,
      });
      setData(next);
      setForm(formOf(next));
      setSaved(true);
    } catch (e) {
      setError(message(e, "The AI agent's settings could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Frame
      menu={menu}
      page={page}
      save={{ dirty, busy, saved, error, onSave: () => void save() }}
    >
      {form && data && (
        <>
          <Card
            title="Answering"
            description="The AI agent answers customers in the messenger from your help content, until it hands the conversation to the team."
          >
            <label className="pg-settings-toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => set({ enabled: e.target.checked })}
              />
              <span>
                <strong>The AI agent answers customers</strong>
                <small className="pg-muted">
                  Off: conversations go straight to the team.
                </small>
              </span>
            </label>
            <fieldset className="pg-settings-fieldset">
              <legend>When it answers</legend>
              {(
                [
                  ["always", "Always", "Day and night."],
                  [
                    "outside_office_hours",
                    "Only outside office hours",
                    "While the team is open, conversations go straight to it. Without office hours set up, the agent always answers.",
                  ],
                ] as const
              ).map(([v, label, help]) => (
                <label key={v} className="pg-settings-toggle">
                  <input
                    type="radio"
                    name="answer-hours"
                    checked={form.answerHours === v}
                    onChange={() => set({ answerHours: v })}
                  />
                  <span>
                    <strong>{label}</strong>
                    <small className="pg-muted">{help}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          </Card>

          <Card
            title="Handing over"
            description="The agent hands a conversation to the team when the customer asks for a person, after answers it couldn't give, or when the customer seems frustrated. It tells the customer, leaves teammates a summary note, and stays out from then on."
          >
            <Field
              label="Hand over to"
              hint="Routing assigns it from this team's queue. With no team, it waits in Unassigned."
            >
              {(id, hint) => (
                <select
                  id={id}
                  aria-describedby={hint}
                  value={form.handoverTeamId ?? ""}
                  onChange={(e) =>
                    set({ handoverTeamId: e.target.value || null })
                  }
                >
                  <option value="">No team (Unassigned)</option>
                  {data.teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field
              label="Answers it couldn't give before handing over"
              hint="Counted per conversation, including errors."
            >
              {(id, hint) => (
                <select
                  id={id}
                  aria-describedby={hint}
                  value={form.failedLimit}
                  onChange={(e) =>
                    set({ failedLimit: Number(e.target.value) })
                  }
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <label className="pg-settings-toggle">
              <input
                type="checkbox"
                checked={form.escalateOnSentiment}
                onChange={(e) => set({ escalateOnSentiment: e.target.checked })}
              />
              <span>
                <strong>Hand over when the customer seems frustrated</strong>
                <small className="pg-muted">
                  Read from each message. Asking for a person always hands
                  over.
                </small>
              </span>
            </label>
          </Card>

          <Card
            title="Outside office hours"
            description="When the agent hands over while the team is away. Office hours come from the handover team's calendar, then the brand's, then the workspace's."
          >
            <div role="radiogroup" aria-label="Outside office hours">
              {(
                [
                  [
                    "reply_time",
                    "Say when the team is back",
                    "“Our team is away right now and back Monday 09:00. They'll reply here then.”",
                  ],
                  [
                    "take_message",
                    "Take a message",
                    "“Our team is away right now. They'll reply here as soon as they're back.”",
                  ],
                  [
                    "continue",
                    "Keep answering until a teammate replies",
                    "The conversation still waits for the team; meanwhile the agent answers what it can.",
                  ],
                ] as const
              ).map(([v, label, help]) => (
                <label key={v} className="pg-settings-toggle">
                  <input
                    type="radio"
                    name="out-of-hours"
                    checked={form.outOfHours === v}
                    onChange={() => set({ outOfHours: v })}
                  />
                  <span>
                    <strong>{label}</strong>
                    <small className="pg-muted">{help}</small>
                  </span>
                </label>
              ))}
            </div>
          </Card>
        </>
      )}
    </Frame>
  );
}
