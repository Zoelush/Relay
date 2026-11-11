import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";
import type { ProviderId } from "../lib/ai-providers";

/**
 * Settings › Knowledge & AI › AI providers (phase 16, step C9d; docs/SECURITY_STEP19.md), for
 * `workspace.manage`: a card per provider, a dialog for its key and model (Save, and Save and
 * test), and which one Zoe answers with first and which takes over when it fails. Keys go to the
 * server once and never come back: the page only ever has their last 4 characters.
 */
type Test = { at: string; ok: boolean; detail: string };
type Connection = {
  keyHint: string;
  baseUrl: string | null;
  model: string;
  classifierModel: string | null;
  role: "primary" | "fallback" | null;
  test: Test | null;
  updatedAt: string;
  lastWeek: { served: number; failedOver: number };
};
type Provider = {
  id: ProviderId;
  name: string;
  company: string;
  description: string;
  where: string;
  models: string[];
  keyPlaceholder: string;
  connection: Connection | null;
};
type Data = { providers: Provider[]; primary: ProviderId | null; fallback: ProviderId | null; relay: { model: string | null } };

/** Waits for a test job, as the connector test console does. */
async function testResult(jobId: string): Promise<{ ok: boolean; detail: string }> {
  for (let i = 0; i < 90; i++) {
    const job = await api<{ state: string; result: { ok: boolean; detail: string } | null }>("job?" + new URLSearchParams({ id: jobId }));
    if (job.state === "succeeded" && job.result) return job.result;
    if (job.state === "dead_letter") throw new Error("The test couldn't run. Try again.");
    await new Promise((r) => setTimeout(r, i < 10 ? 400 : 1000));
  }
  throw new Error("The test is taking a long time. Its result will show on the provider's card.");
}
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function ProviderDialog({ provider, onClose, onSaved }: { provider: Provider; onClose: () => void; onSaved: (d: Data) => void }) {
  const c = provider.connection;
  const [key, setKey] = useState("");
  const [model, setModel] = useState(c?.model ?? provider.models[0] ?? "");
  const [classifierModel, setClassifierModel] = useState(c?.classifierModel ?? "");
  const [baseUrl, setBaseUrl] = useState(c?.baseUrl ?? "");
  const [phase, setPhase] = useState<"" | "Saving…" | "Testing…">("");
  const busy = phase !== "";
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const listId = `models-${provider.id}`;
  async function save(test: boolean) {
    setPhase("Saving…");
    setError("");
    setResult(null);
    try {
      const saved = await api<Data & { jobId?: string }>("ai-providers", {
        action: "save",
        provider: provider.id,
        key,
        model,
        classifierModel,
        ...(provider.id === "custom" ? { baseUrl } : {}),
        test,
      });
      setKey("");
      onSaved(saved);
      if (!test || !saved.jobId) return onClose();
      setPhase("Testing…");
      setResult(await testResult(saved.jobId));
      onSaved(await api<Data>("ai-providers"));
    } catch (e) {
      setError(message(e, "The provider couldn't be saved."));
    } finally {
      setPhase("");
    }
  }
  // Named as it was opened: saving a new connection doesn't rename the dialog under the manager.
  const [title] = useState(() => `${c ? "Edit" : "Connect"} ${provider.name}`);
  return (
    <div className="pg-modal-backdrop" onKeyDown={(e) => e.key === "Escape" && !busy && onClose()} onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <section role="dialog" aria-modal="true" aria-label={title} className="pg-dialog">
        <header className="pg-email-head">
          <h2>{title}</h2>
          <button type="button" className="pg-wf-icon" aria-label="Close" onClick={onClose} disabled={busy}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <form
          className="pg-settings-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void save(false);
          }}
        >
          <p className="pg-muted pg-settings-small">{provider.description}</p>
          {provider.id === "custom" && (
            <label className="pg-settings-field">
              <span className="pg-settings-label">Base URL</span>
              <input
                ref={first}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                inputMode="url"
                autoComplete="off"
                aria-label="Base URL"
                aria-describedby="base-hint"
              />
              <small id="base-hint" className="pg-muted">
                Relay sends requests to this address followed by /chat/completions. It must be a public https address.
              </small>
            </label>
          )}
          <label className="pg-settings-field">
            <span className="pg-settings-label">API key</span>
            <input
              ref={provider.id === "custom" ? undefined : first}
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={c ? (c.keyHint ? `Saved key ending in ${c.keyHint}: leave empty to keep it` : "Saved: leave empty to keep it") : provider.keyPlaceholder}
              autoComplete="off"
              spellCheck={false}
              aria-label="API key"
              aria-describedby="key-hint"
            />
            <small id="key-hint" className="pg-muted">
              Keys are encrypted on the server and never sent back to the browser.
            </small>
          </label>
          <label className="pg-settings-field">
            <span className="pg-settings-label">Model</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} list={listId} autoComplete="off" spellCheck={false} aria-label="Model" aria-describedby="model-hint" />
            <small id="model-hint" className="pg-muted">
              {provider.models.length ? `For example ${provider.models.join(", ")}. ` : ""}Type the name exactly as {provider.company === "Your endpoint" ? "your endpoint" : provider.company} lists it.
            </small>
          </label>
          <label className="pg-settings-field">
            <span className="pg-settings-label">Model for classifying messages (optional)</span>
            <input value={classifierModel} onChange={(e) => setClassifierModel(e.target.value)} list={listId} autoComplete="off" spellCheck={false} aria-label="Model for classifying messages (optional)" aria-describedby="classifier-hint" />
            <small id="classifier-hint" className="pg-muted">
              Zoe reads each customer message for a request for a person, sentiment and topic. A smaller model is cheaper; leave it empty to use the model above.
            </small>
          </label>
          <datalist id={listId}>
            {provider.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <p className="pg-muted pg-settings-small">{provider.where}</p>
          {error && (
            <p role="alert" className="pg-attr-error">
              {error}
            </p>
          )}
          {busy && (
            <p role="status" className="pg-muted">
              {phase}
            </p>
          )}
          {result &&
            (result.ok ? (
              <p role="status" className="pg-settings-notice">
                {result.detail}
              </p>
            ) : (
              <p role="alert" className="pg-attr-error">
                Test failed: {result.detail}
              </p>
            ))}
          <span className="pg-settings-actions">
            <button type="button" className="pg-secondary" onClick={onClose} disabled={busy}>
              {result ? "Done" : "Cancel"}
            </button>
            <button type="submit" className="pg-secondary" disabled={busy}>
              Save
            </button>
            <button type="button" className="pg-primary" disabled={busy} onClick={() => void save(true)}>
              Save and test
            </button>
          </span>
        </form>
      </section>
    </div>
  );
}

function ProviderCard({ p, onEdit, onChanged }: { p: Provider; onEdit: () => void; onChanged: (d: Data) => void }) {
  const c = p.connection;
  const [confirming, setConfirming] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  async function test() {
    setTesting(true);
    setError("");
    try {
      const { jobId } = await api<{ jobId: string }>("ai-providers", { action: "test", provider: p.id });
      await testResult(jobId);
      onChanged(await api<Data>("ai-providers"));
    } catch (e) {
      setError(message(e, "The test couldn't run."));
    } finally {
      setTesting(false);
    }
  }
  async function remove() {
    setError("");
    try {
      onChanged(await api<Data>("ai-providers", { action: "remove", provider: p.id }));
    } catch (e) {
      setError(message(e, "The provider couldn't be removed."));
    }
  }
  return (
    <li className="pg-ai-provider" data-role={c?.role ?? undefined} aria-label={p.name}>
      <header>
        <h4>{p.name}</h4>
        <span className="pg-health-badge" data-severity={c ? (c.test && !c.test.ok ? "critical" : "ok") : undefined}>
          {c ? (c.role === "primary" ? "Primary" : c.role === "fallback" ? "Fallback" : "Connected") : "Not connected"}
        </span>
      </header>
      <p className="pg-muted pg-settings-small">{p.description}</p>
      {c && (
        <dl className="pg-ai-provider-facts">
          <dt>Model</dt>
          <dd>
            {c.model}
            {c.classifierModel && c.classifierModel !== c.model ? ` (classifying: ${c.classifierModel})` : ""}
          </dd>
          <dt>Key</dt>
          <dd>{c.keyHint ? `•••• ${c.keyHint}` : "Saved"}</dd>
          {c.baseUrl && (
            <>
              <dt>Address</dt>
              <dd>{c.baseUrl}</dd>
            </>
          )}
          <dt>Last test</dt>
          <dd>{c.test ? `${c.test.ok ? "Passed" : "Failed"} ${when(c.test.at)}: ${c.test.detail}` : "Not tested since it was saved"}</dd>
          <dt>Last 7 days</dt>
          <dd>
            {c.lastWeek.served} {c.lastWeek.served === 1 ? "call" : "calls"} answered
            {c.lastWeek.failedOver ? `; the fallback took over ${c.lastWeek.failedOver} ${c.lastWeek.failedOver === 1 ? "time" : "times"}` : ""}
          </dd>
        </dl>
      )}
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <span className="pg-settings-buttons">
        <button type="button" className={c ? "pg-secondary" : "pg-primary"} onClick={onEdit} aria-label={`${c ? "Edit" : "Connect"} ${p.name}`}>
          {c ? "Edit" : "Connect"}
        </button>
        {c && (
          <button type="button" className="pg-secondary" onClick={() => void test()} disabled={testing} aria-label={`Test ${p.name}`}>
            {testing ? "Testing…" : "Test"}
          </button>
        )}
        {c &&
          (confirming ? (
            <>
              <button type="button" className="pg-secondary" onClick={() => void remove()} aria-label={`Confirm removing ${p.name}`}>
                Remove{c.role === "primary" ? " (Zoe goes back to Relay's AI)" : ""}
              </button>
              <button type="button" className="pg-secondary" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" className="pg-secondary" onClick={() => setConfirming(true)} aria-label={`Remove ${p.name}`}>
              Remove
            </button>
          ))}
      </span>
    </li>
  );
}

export function AiProvidersPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Data | null>(null);
  const [editing, setEditing] = useState<ProviderId | null>(null);
  const [primary, setPrimary] = useState("");
  const [fallback, setFallback] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const take = (d: Data) => {
    setData(d);
    setPrimary(d.primary ?? "");
    setFallback(d.fallback ?? "");
  };
  useEffect(() => {
    api<Data>("ai-providers")
      .then(take)
      .catch((e) => setError(message(e, "AI providers couldn't be loaded.")));
  }, []);
  async function saveRoles() {
    setError("");
    setNotice("");
    try {
      take(await api<Data>("ai-providers", { action: "roles", primary: primary || null, fallback: primary ? fallback || null : null }));
      setNotice(primary ? "Zoe now answers with your own provider." : "Zoe now answers with Relay's AI.");
    } catch (e) {
      setError(message(e, "The choice couldn't be saved."));
    }
  }
  const connected = data?.providers.filter((p) => p.connection) ?? [];
  const relayName = data?.relay.model ? `Relay's AI (${data.relay.model})` : "Relay's AI";
  const open = data?.providers.find((p) => p.id === editing) ?? null;
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
      {data && (
        <>
          <Card
            title="Zoe answers with"
            description="Relay's AI, unless you choose one of your own providers. With your own key, you pay the provider for what Zoe uses, and AI resolutions are billed at the own-key price. The fallback is used only when the primary fails or doesn't answer in time; Relay's AI is never used while a primary is set."
          >
            <form
              className="pg-settings-row"
              aria-label="Zoe's providers"
              onSubmit={(e) => {
                e.preventDefault();
                void saveRoles();
              }}
            >
              <label className="pg-settings-field">
                <span className="pg-settings-label">Primary</span>
                <select
                  value={primary}
                  onChange={(e) => {
                    setPrimary(e.target.value);
                    if (e.target.value === fallback) setFallback("");
                  }}
                >
                  <option value="">{relayName}</option>
                  {connected.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.connection!.model})
                    </option>
                  ))}
                </select>
              </label>
              <label className="pg-settings-field">
                <span className="pg-settings-label">Fallback</span>
                <select value={fallback} onChange={(e) => setFallback(e.target.value)} disabled={!primary}>
                  <option value="">None</option>
                  {connected
                    .filter((p) => p.id !== primary)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.connection!.model})
                      </option>
                    ))}
                </select>
              </label>
              <span className="pg-settings-buttons">
                <button type="submit" className="pg-primary">
                  Save choice
                </button>
              </span>
            </form>
            {!connected.length && <p className="pg-muted pg-settings-small">Connect a provider below to choose it here.</p>}
          </Card>
          <Card title="Providers" description="Connect a provider with your own API key and the model Zoe should use. Zoe's rules, redaction and safety checks are the same whichever model answers.">
            <ul className="pg-ai-providers" aria-label="AI providers">
              {data.providers.map((p) => (
                <ProviderCard key={p.id} p={p} onEdit={() => setEditing(p.id)} onChanged={take} />
              ))}
            </ul>
          </Card>
        </>
      )}
      {open && <ProviderDialog provider={open} onClose={() => setEditing(null)} onSaved={take} />}
    </Frame>
  );
}
