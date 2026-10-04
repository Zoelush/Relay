import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Field, message } from "./settings-ui";
import { ZOE_LANGUAGES } from "../lib/zoe-voice";

/**
 * The AI agent's settings (phase 08 A2a, A2b, A3), edited in Zoe's area (Z1; docs/AI_STEP5.md):
 * when she answers and how sure she must be, how she hands conversations to the team, escalation
 * rules, never-handle topics and guidance, and the resolution window. One versioned save covers
 * them all; each of Zoe's pages shows the sections it's about.
 */
export type Condition = {
  field: string;
  op: string;
  value: string | boolean;
  key?: string;
};
type Rule = {
  id?: string;
  name: string;
  enabled: boolean;
  match: "all" | "any";
  conditions: Condition[];
};
type Topic = { name: string; description: string; keywords: string[] };
type Choice = { id: string; name: string };
/** What a rule can check, the comparisons each takes, and its starting condition. */
const FIELDS: [string, string, [string, string][]][] = [
  ["signed_in", "Customer is signed in", [["is", "is"]]],
  ["email_domain", "Email domain", [["is", "is"], ["is_not", "is not"]]],
  ["brand", "Brand", [["is", "is"], ["is_not", "is not"]]],
  ["language", "Language", [["is", "is"], ["is_not", "is not"]]],
  [
    "page",
    "Page address",
    [
      ["contains", "contains"],
      ["starts_with", "starts with"],
      ["equals", "is exactly"],
    ],
  ],
  ["tag", "Conversation tag", [["has", "has"], ["has_not", "hasn't"]]],
  [
    "attribute",
    "Conversation attribute",
    [
      ["is", "is"],
      ["is_not", "is not"],
      ["is_set", "is set"],
    ],
  ],
];
export const fresh = (field: string): Condition => ({
  field,
  op: FIELDS.find(([f]) => f === field)![2][0][0],
  value: field === "signed_in" ? true : "",
});
export type Settings = {
  agent: {
    id: string;
    name: string;
    enabled: boolean;
    handoverTeamId: string | null;
    answerHours: "always" | "outside_office_hours";
    outOfHours: "continue" | "take_message" | "reply_time";
    failedLimit: number;
    escalateOnSentiment: boolean;
    resolutionWindowHours: number;
    /** How sure she must be to answer (0.2 to 0.9; the confidence gate). */
    threshold: number;
    /** The languages she answers in, and what she does with others (Z2). */
    languages: string[];
    otherLanguages: "brand_language" | "hand_over";
    version: string;
  };
  teams: Choice[];
  choices: { brands: Choice[]; tags: Choice[]; attributes: Choice[] };
  rules: Rule[];
  topics: Topic[];
  guidance: string[];
  /** Zoe's identity on each brand (Z1). */
  identities: {
    brandId: string;
    brandName: string;
    name: string;
    avatar: string;
    avatarDark: string;
    disclosure: string;
    greeting: string;
  }[];
  /** The resolution ledger (A3). */
  resolutions: {
    last30Days: { resolutions: number; reversals: number; net: number };
    recent: {
      id: string;
      kind: "resolution" | "reversal";
      rule: string;
      conversationId: string;
      title: string;
      at: string;
      detail: string;
      answers: number;
    }[];
  };
};
export type Form = Omit<Settings["agent"], "id" | "name" | "version"> & {
  rules: Rule[];
  topics: Topic[];
  guidance: string[];
};
const formOf = (s: Settings): Form => ({
  enabled: s.agent.enabled,
  handoverTeamId: s.agent.handoverTeamId,
  answerHours: s.agent.answerHours,
  outOfHours: s.agent.outOfHours,
  failedLimit: s.agent.failedLimit,
  escalateOnSentiment: s.agent.escalateOnSentiment,
  resolutionWindowHours: s.agent.resolutionWindowHours,
  threshold: s.agent.threshold,
  languages: s.agent.languages,
  otherLanguages: s.agent.otherLanguages,
  rules: s.rules,
  topics: s.topics,
  guidance: s.guidance,
});

/** The agent's settings: loaded once, edited as a form, saved from the version read. */
export function useAiSettings() {
  const [data, setData] = useState<Settings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(
    () =>
      api<Settings>("ai-settings")
        .then((s) => {
          setData(s);
          setForm(formOf(s));
        })
        .catch((e) => setError(message(e, "This page could not be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const dirty =
    !!data && !!form && JSON.stringify(form) !== JSON.stringify(formOf(data));
  const set = (change: Partial<Form>) => {
    setSaved(false);
    setForm((f) => f && { ...f, ...change });
  };
  async function save(change: Partial<Form> = {}) {
    if (!data || !form) return;
    setBusy(true);
    setError("");
    try {
      const next = await api<Settings>("ai-settings", {
        ...form,
        ...change,
        version: data.agent.version,
      });
      setData(next);
      setForm(formOf(next));
      setSaved(true);
    } catch (e) {
      setError(message(e, "Zoe's settings could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  return { data, form, set, dirty, busy, saved, error, save, reload: load };
}
type Section = {
  form: Form;
  set: (change: Partial<Form>) => void;
  data: Settings;
};

/** The languages she answers in, and what she does when a customer writes in another (Z2). */
export function LanguagesCard({ form, set }: Omit<Section, "data">) {
  return (
    <Card
      title="Languages"
      description="She answers in the language the customer writes in, when it's one of these. Short messages such as “ok” keep the conversation's language, then the customer's browser's."
    >
      <fieldset className="pg-settings-fieldset">
        <legend>Languages she answers in</legend>
        <div className="pg-zoe-languages">
          {ZOE_LANGUAGES.map((l) => (
            <label key={l.id} className="pg-settings-toggle">
              <input
                type="checkbox"
                checked={form.languages.includes(l.id)}
                onChange={(e) =>
                  set({
                    languages: ZOE_LANGUAGES.map((x) => x.id).filter((id) =>
                      id === l.id ? e.target.checked : form.languages.includes(id),
                    ),
                  })
                }
              />
              <span>
                <strong>{l.name}</strong>
                <small className="pg-muted" lang={l.id}>
                  {l.native}
                </small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="pg-settings-fieldset">
        <legend>When a customer writes in another language</legend>
        {(
          [
            [
              "brand_language",
              "Reply in the brand's language",
              "She answers in the brand's own language (or the first of hers, if that isn't one).",
            ],
            [
              "hand_over",
              "Hand over to the team",
              "She hands the conversation over, as for any other handover. Only when she read the language in what they wrote; a browser setting alone never hands over.",
            ],
          ] as const
        ).map(([value, label, hint]) => (
          <label key={value} className="pg-settings-toggle">
            <input
              type="radio"
              name="other-languages"
              checked={form.otherLanguages === value}
              onChange={() => set({ otherLanguages: value })}
            />
            <span>
              <strong>{label}</strong>
              <small className="pg-muted">{hint}</small>
            </span>
          </label>
        ))}
      </fieldset>
    </Card>
  );
}

/** When she answers, and how sure she must be. */
export function AnsweringCard({ form, set }: Omit<Section, "data">) {
  return (
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
            <strong>Zoe answers customers</strong>
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
                "While the team is open, conversations go straight to it. Without office hours set up, Zoe always answers.",
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
  );
}

/** How she hands over, and what she does while the team is away. */
export function HandoverCards({ form, set, data }: Section) {
  return (
    <>
      <Card
        title="Handing over"
        description="Zoe hands a conversation to the team when the customer asks for a person, after answers she couldn't give, or when the customer seems frustrated. She tells the customer, leaves teammates a summary note, and stays out from then on."
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
          label="Answers she couldn't give before handing over"
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
        description="When Zoe hands over while the team is away. Office hours come from the handover team's calendar, then the brand's, then the workspace's."
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
                "The conversation still waits for the team; meanwhile Zoe answers what she can.",
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
  );
}

/** The resolution window, and the ledger's last 30 days. */
export function ResolutionsCard({ form, set, data }: Section) {
  return (
      <Card
        title="Resolutions"
        description="When Zoe resolved a conversation: the customer tapped “That helped” under an answer from your content, or didn't write again within the window after one, and it was never handed to the team. Each is a row in a ledger that's never changed; a handover within the window adds a reversal."
      >
        <Field
          label="Resolution window"
          hint="How long after an answer the customer's silence counts as resolved, and how long a resolution can still be reversed by a handover."
        >
          {(id, hint) => (
            <select
              id={id}
              aria-describedby={hint}
              value={form.resolutionWindowHours}
              onChange={(e) =>
                set({ resolutionWindowHours: Number(e.target.value) })
              }
            >
              {[1, 4, 12, 24, 48, 72].map((h) => (
                <option key={h} value={h}>
                  {h} {h === 1 ? "hour" : "hours"}
                </option>
              ))}
            </select>
          )}
        </Field>
        <p className="pg-settings-small" data-testid="resolution-count">
          Last 30 days: <strong>{data.resolutions.last30Days.net}</strong>{" "}
          {data.resolutions.last30Days.net === 1 ? "resolution" : "resolutions"}
          {data.resolutions.last30Days.reversals > 0 &&
            ` (${data.resolutions.last30Days.resolutions} recorded, ${data.resolutions.last30Days.reversals} reversed)`}
          .
        </p>
        {data.resolutions.recent.length > 0 && (
          <ul className="pg-settings-list" aria-label="Latest resolutions">
            {data.resolutions.recent.map((r) => (
              <li key={r.id}>
                <span>
                  <strong>
                    {r.kind === "reversal"
                      ? "Reversed"
                      : r.rule === "confirmed"
                        ? "Confirmed by the customer"
                        : "No reply within the window"}
                    {" · "}
                    {r.title || "Conversation"}
                  </strong>
                  <small className="pg-muted">
                    {new Date(r.at).toLocaleString()} · {r.detail}
                    {r.kind === "resolution" &&
                      ` · ${r.answers} ${r.answers === 1 ? "answer" : "answers"}`}{" "}
                    · conversation {r.conversationId}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
  );
}

/** Subjects she never answers. */
export function TopicsCard({ form, set }: Omit<Section, "data">) {
  return (
      <Card
        title="Never-handle topics"
        description="Subjects Zoe never answers: she hands the conversation over instead. Keywords are checked word for word, even if the model is unavailable; the model also recognises the topic from its name and description."
      >
        <ul className="pg-settings-list" aria-label="Never-handle topics">
          {form.topics.map((t, i) => {
            const change = (c: Partial<Topic>) =>
              set({
                topics: form.topics.map((x, j) =>
                  j === i ? { ...x, ...c } : x,
                ),
              });
            return (
              <li key={i} className="pg-ai-topic">
                <input
                  aria-label={`Topic ${i + 1} name`}
                  placeholder="Legal"
                  maxLength={80}
                  value={t.name}
                  onChange={(e) => change({ name: e.target.value })}
                />
                <input
                  aria-label={`Topic ${i + 1} description`}
                  placeholder="Complaints that mention lawyers, courts or legal action"
                  maxLength={300}
                  value={t.description}
                  onChange={(e) => change({ description: e.target.value })}
                />
                <input
                  aria-label={`Topic ${i + 1} keywords`}
                  placeholder="lawyer, solicitor, court"
                  value={t.keywords.join(",")}
                  onChange={(e) =>
                    change({ keywords: e.target.value.split(",") })
                  }
                />
                <button
                  type="button"
                  aria-label={`Remove topic ${i + 1}`}
                  onClick={() =>
                    set({ topics: form.topics.filter((_, j) => j !== i) })
                  }
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
        <div>
          <button
            type="button"
            disabled={form.topics.length >= 20}
            onClick={() =>
              set({
                topics: [
                  ...form.topics,
                  { name: "", description: "", keywords: [] },
                ],
              })
            }
          >
            Add topic
          </button>
        </div>
      </Card>
  );
}

/** Plain-language instructions on when a person should take over. */
export function GuidanceCard({ form, set }: Omit<Section, "data">) {
  return (
      <Card
        title="Escalation guidance"
        description="Plain-language instructions on when a person should take over, such as: Hand over if the customer mentions “cancel my account”. Guidance only decides whether to hand over; it can't change what Zoe may do."
      >
        {form.guidance.map((g, i) => (
          <div key={i} className="pg-settings-row">
            <textarea
              aria-label={`Guidance ${i + 1}`}
              rows={2}
              maxLength={500}
              value={g}
              onChange={(e) =>
                set({
                  guidance: form.guidance.map((x, j) =>
                    j === i ? e.target.value : x,
                  ),
                })
              }
            />
            <button
              type="button"
              aria-label={`Remove guidance ${i + 1}`}
              onClick={() =>
                set({ guidance: form.guidance.filter((_, j) => j !== i) })
              }
            >
              ×
            </button>
          </div>
        ))}
        <div>
          <button
            type="button"
            disabled={form.guidance.length >= 10}
            onClick={() => set({ guidance: [...form.guidance, ""] })}
          >
            Add guidance
          </button>
        </div>
      </Card>
  );
}

/** Escalation rules (A2b): when one matches, the agent hands over without answering. */
/**
 * The rows of a set of conditions (the escalation rules' closed list): what to check, how, and
 * against what. Shared by escalation rules and (Z3a) specialists' "Only when".
 */
export function ConditionRows({
  label: prefix,
  conditions,
  choices,
  min = 1,
  onChange,
}: {
  label: string;
  conditions: Condition[];
  choices: Settings["choices"];
  /** How many must stay (a rule needs one; a specialist none). */
  min?: number;
  onChange: (conditions: Condition[]) => void;
}) {
  const setCondition = (k: number, c: Partial<Condition>) =>
    onChange(conditions.map((x, j) => (j === k ? { ...x, ...c } : x)));
  return (
    <>
      {conditions.map((c, k) => {
        const label = `${prefix} condition ${k + 1}`;
        const ops = FIELDS.find(([f]) => f === c.field)?.[2] ?? [];
        const options =
          c.field === "brand"
            ? choices.brands
            : c.field === "tag"
              ? choices.tags
              : null;
        return (
          <div key={k} className="pg-settings-row">
            <select
              aria-label={`${label} field`}
              value={c.field}
              onChange={(e) => setCondition(k, fresh(e.target.value))}
            >
              {FIELDS.map(([f, name]) => (
                <option key={f} value={f}>
                  {name}
                </option>
              ))}
            </select>
            {c.field === "attribute" && (
              <select
                aria-label={`${label} attribute`}
                value={c.key ?? ""}
                onChange={(e) => setCondition(k, { key: e.target.value })}
              >
                <option value="">Choose an attribute…</option>
                {choices.attributes.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
            {c.field !== "signed_in" && (
              <select
                aria-label={`${label} comparison`}
                value={c.op}
                onChange={(e) => setCondition(k, { op: e.target.value })}
              >
                {ops.map(([v, name]) => (
                  <option key={v} value={v}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            {c.field === "signed_in" ? (
              <select
                aria-label={`${label} value`}
                value={String(c.value)}
                onChange={(e) =>
                  setCondition(k, { value: e.target.value === "true" })
                }
              >
                <option value="true">Yes</option>
                <option value="false">No (a visitor)</option>
              </select>
            ) : options ? (
              <select
                aria-label={`${label} value`}
                value={String(c.value)}
                onChange={(e) => setCondition(k, { value: e.target.value })}
              >
                <option value="">Choose…</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            ) : c.op !== "is_set" ? (
              <input
                aria-label={`${label} value`}
                placeholder={
                  c.field === "email_domain"
                    ? "example.com"
                    : c.field === "language"
                      ? "fr"
                      : c.field === "page"
                        ? "/enterprise"
                        : "Value"
                }
                maxLength={300}
                value={String(c.value)}
                onChange={(e) => setCondition(k, { value: e.target.value })}
              />
            ) : null}
            <button
              type="button"
              aria-label={`Remove ${label}`}
              disabled={conditions.length <= min}
              onClick={() => onChange(conditions.filter((_, j) => j !== k))}
            >
              ×
            </button>
          </div>
        );
      })}
    </>
  );
}

export function Rules({
  rules,
  choices,
  onChange,
}: {
  rules: Rule[];
  choices: Settings["choices"];
  onChange: (rules: Rule[]) => void;
}) {
  const change = (i: number, c: Partial<Rule>) =>
    onChange(rules.map((r, j) => (j === i ? { ...r, ...c } : r)));
  return (
    <Card
      title="Escalation rules"
      description="Customers and conversations a person should always handle. Checked on every customer message, before the agent answers, in order; the first that matches hands the conversation over. Company and contact attributes arrive with the people service."
    >
      {rules.map((r, i) => {
        const n = i + 1;
        return (
          <fieldset key={r.id ?? i} className="pg-settings-fieldset">
            <legend>Rule {n}</legend>
            <div className="pg-settings-row">
              <input
                aria-label={`Rule ${n} name`}
                placeholder="Enterprise customers"
                maxLength={120}
                value={r.name}
                onChange={(e) => change(i, { name: e.target.value })}
              />
              <select
                aria-label={`Rule ${n} needs`}
                value={r.match}
                onChange={(e) =>
                  change(i, { match: e.target.value as Rule["match"] })
                }
              >
                <option value="all">All conditions</option>
                <option value="any">Any condition</option>
              </select>
              <label className="pg-settings-inline">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => change(i, { enabled: e.target.checked })}
                />
                On
              </label>
              <button
                type="button"
                aria-label={`Remove rule ${n}`}
                onClick={() => onChange(rules.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
            <ConditionRows
              label={`Rule ${n}`}
              conditions={r.conditions}
              choices={choices}
              onChange={(conditions) => change(i, { conditions })}
            />
            <div>
              <button
                type="button"
                disabled={r.conditions.length >= 10}
                onClick={() =>
                  change(i, { conditions: [...r.conditions, fresh("signed_in")] })
                }
              >
                Add condition to rule {n}
              </button>
            </div>
          </fieldset>
        );
      })}
      <div>
        <button
          type="button"
          disabled={rules.length >= 20}
          onClick={() =>
            onChange([
              ...rules,
              {
                name: "",
                enabled: true,
                match: "all",
                conditions: [fresh("signed_in")],
              },
            ])
          }
        >
          Add rule
        </button>
      </div>
    </Card>
  );
}
