import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › Security › Data protection (phase 16, step C6b; docs/SECURITY_STEP10.md), for
 * `security.manage`, behind `security_v1`: built-in redaction rules, custom patterns (tried on a
 * sample before they're added; the server refuses unsafe ones with the reason), and what Zoe sends
 * to the model provider. Rules apply to text stored from then on. C7a adds the two risky-merge
 * switches (docs/SECURITY_STEP11.md).
 */
type DataProtection = {
  builtIns: { id: string; label: string; example: string; enabled: boolean }[];
  custom: { id: string; name: string; pattern: string; enabled: boolean }[];
  model: {
    redactPersonalData: boolean;
    memory: boolean;
    historyMessages: number;
  };
  merges: { acrossPeople: boolean; leadsByEmail: boolean };
};

export function DataProtectionPage({
  menu,
  page,
}: {
  menu: MenuState;
  page: Page;
}) {
  const [data, setData] = useState<DataProtection | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("");
  const [sample, setSample] = useState("");
  const [tried, setTried] = useState<string | null>(null);
  const [patternError, setPatternError] = useState("");
  const load = useCallback(
    () =>
      api<DataProtection>("data-protection")
        .then(setData)
        .catch((e) =>
          setError(message(e, "Data protection couldn't be loaded.")),
        ),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (
    p: Record<string, unknown>,
    done: string,
    fallback: string,
  ) => {
    setError("");
    setNotice("");
    try {
      setData(await api<DataProtection>("data-protection", p));
      setNotice(done);
      return true;
    } catch (e) {
      setError(message(e, fallback));
      void load();
      return false;
    }
  };
  const tryPattern = async () => {
    setPatternError("");
    setTried(null);
    try {
      setTried(
        (
          await api<{ result: string }>("data-protection", {
            action: "try",
            pattern,
            sample,
          })
        ).result,
      );
    } catch (e) {
      setPatternError(message(e, "That pattern couldn't be tried."));
    }
  };
  const add = async () => {
    setPatternError("");
    try {
      setData(
        await api<DataProtection>("data-protection", {
          action: "custom-add",
          name,
          pattern,
        }),
      );
      setNotice("Pattern added.");
      setName("");
      setPattern("");
      setSample("");
      setTried(null);
    } catch (e) {
      setPatternError(message(e, "That pattern couldn't be added."));
    }
  };
  const model = data?.model;
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
      {data && model && (
        <>
          <Card
            title="Redaction"
            description="Matches become asterisks as messages, emails, drafts and channel payloads are stored, so teammates, search, exports and Zoe never see them. Rules apply from when they're turned on: text already stored isn't changed."
          >
            <div role="group" aria-label="Built-in rules">
              {data.builtIns.map((b) => (
                <label key={b.id} className="pg-settings-check">
                  <input
                    type="checkbox"
                    checked={b.enabled}
                    onChange={(e) => {
                      // Shown at once; put back from the server if the change is refused.
                      const on = e.target.checked;
                      setData({
                        ...data,
                        builtIns: data.builtIns.map((x) =>
                          x.id === b.id ? { ...x, enabled: on } : x,
                        ),
                      });
                      void act(
                        { action: "builtin", builtin: b.id, on },
                        `${b.label} ${on ? "are now redacted" : "are no longer redacted"}.`,
                        "That couldn't be changed.",
                      );
                    }}
                  />
                  <span>
                    {b.label}{" "}
                    <small className="pg-muted">like {b.example}</small>
                  </span>
                </label>
              ))}
            </div>
          </Card>
          <Card
            title="Custom patterns"
            description="Regular expressions for anything else, such as your own account numbers. Up to 25. Patterns that could run slowly are refused."
          >
            {data.custom.length ? (
              <ul className="pg-settings-list" aria-label="Custom patterns">
                {data.custom.map((c) => (
                  <li key={c.id}>
                    <label className="pg-settings-check">
                      <input
                        type="checkbox"
                        checked={c.enabled}
                        aria-label={`Redact ${c.name}`}
                        onChange={(e) => {
                          const on = e.target.checked;
                          setData({
                            ...data,
                            custom: data.custom.map((x) =>
                              x.id === c.id ? { ...x, enabled: on } : x,
                            ),
                          });
                          void act(
                            { action: "custom-toggle", id: c.id, on },
                            on ? `${c.name} is on.` : `${c.name} is off.`,
                            "That couldn't be changed.",
                          );
                        }}
                      />
                      <span>
                        {c.name} <code>{c.pattern}</code>
                      </span>
                    </label>
                    <button
                      type="button"
                      className="pg-wf-link pg-danger-link"
                      aria-label={`Remove ${c.name}`}
                      onClick={() =>
                        void act(
                          { action: "custom-remove", id: c.id },
                          `${c.name} removed.`,
                          "It couldn't be removed.",
                        )
                      }
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pg-muted">No custom patterns yet.</p>
            )}
            <form
              className="pg-signin-settings"
              aria-label="Add a pattern"
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <label className="pg-settings-field">
                <span className="pg-settings-label">Name</span>
                <input
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="pg-settings-field">
                <span className="pg-settings-label">Pattern</span>
                <input
                  value={pattern}
                  maxLength={200}
                  spellCheck={false}
                  aria-invalid={!!patternError}
                  aria-describedby="pattern-hint"
                  onChange={(e) => {
                    setPattern(e.target.value);
                    setTried(null);
                    setPatternError("");
                  }}
                />
                <small id="pattern-hint" className="pg-muted">
                  For example <code>ACC-\d{"{8}"}</code>. No back-references or
                  look-arounds.
                </small>
              </label>
              <label className="pg-settings-field">
                <span className="pg-settings-label">Try it on</span>
                <input
                  value={sample}
                  maxLength={2000}
                  onChange={(e) => setSample(e.target.value)}
                />
              </label>
              {patternError && (
                <p role="alert" className="pg-attr-error">
                  {patternError}
                </p>
              )}
              {tried !== null && (
                <p className="pg-muted" aria-label="Result">
                  Becomes: <code>{tried}</code>
                </p>
              )}
              <span className="pg-settings-buttons">
                <button
                  type="button"
                  className="pg-secondary"
                  disabled={!pattern}
                  onClick={() => void tryPattern()}
                >
                  Try
                </button>
                <button
                  type="submit"
                  className="pg-primary"
                  disabled={!name.trim() || !pattern}
                >
                  Add pattern
                </button>
              </span>
            </form>
          </Card>
          <Card
            title="What Zoe sends to the model"
            description="Zoe's answers are written by a model provider. Each call is recorded for 90 days with these settings."
          >
            <form
              className="pg-signin-settings"
              aria-label="Model controls"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void act(
                  {
                    action: "model",
                    redactPersonalData: f.get("redact") === "on",
                    memory: f.get("memory") === "on",
                    historyMessages: Number(f.get("history")),
                  },
                  "Model controls saved.",
                  "They couldn't be saved.",
                );
              }}
            >
              <label className="pg-settings-check">
                <input
                  type="checkbox"
                  name="redact"
                  defaultChecked={model.redactPersonalData}
                />
                <span>
                  Remove personal data (emails, phone numbers, cards) before
                  sending
                </span>
              </label>
              <label className="pg-settings-check">
                <input
                  type="checkbox"
                  name="memory"
                  defaultChecked={model.memory}
                />
                <span>
                  Send a signed-in customer&apos;s earlier conversations
                  (memory)
                </span>
              </label>
              <label className="pg-settings-field">
                <span className="pg-settings-label">
                  Earlier messages sent with each question
                </span>
                <select
                  name="history"
                  defaultValue={String(model.historyMessages)}
                >
                  <option value="0">None</option>
                  <option value="5">5</option>
                  <option value="10">10</option>
                </select>
              </label>
              <span className="pg-settings-buttons">
                <button type="submit" className="pg-primary">
                  Save model controls
                </button>
              </span>
            </form>
          </Card>
          <Card title="Risky merges" description="Both are off unless you need them. Every merge they allow is in the audit log. A lead merged by email can be split again; merged conversations can't.">
            <div role="group" aria-label="Risky merges">
              <label className="pg-settings-check">
                <input
                  type="checkbox"
                  checked={data.merges.acrossPeople}
                  aria-describedby="merge-across-hint"
                  onChange={(e) => {
                    const merges = { ...data.merges, acrossPeople: e.target.checked };
                    setData({ ...data, merges });
                    void act({ action: "merges", ...merges }, "Merge settings saved.", "They couldn't be saved.");
                  }}
                />
                <span>Allow merging conversations of different people</span>
              </label>
              <small id="merge-across-hint" className="pg-muted">
                Both people become participants, so each sees the whole conversation, the other&apos;s messages included. Each merge asks for confirmation.
              </small>
              <label className="pg-settings-check">
                <input
                  type="checkbox"
                  checked={data.merges.leadsByEmail}
                  aria-describedby="merge-leads-hint"
                  onChange={(e) => {
                    const merges = { ...data.merges, leadsByEmail: e.target.checked };
                    setData({ ...data, merges });
                    void act({ action: "merges", ...merges }, "Merge settings saved.", "They couldn't be saved.");
                  }}
                />
                <span>Merge a messenger lead into the user with the same email</span>
              </label>
              <small id="merge-leads-hint" className="pg-muted">
                Anyone can type an email, so the person may not be who they say. When a lead writes, they join the only user with that email; their device still sees only its own conversations.
              </small>
            </div>
          </Card>
        </>
      )}
    </Frame>
  );
}
