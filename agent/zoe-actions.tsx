import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Plug, Plus, Trash2 } from "lucide-react";
import { api } from "./api";
import type { SideMenuState } from "./shell";
import { Card, Frame, message, type Page } from "./settings-ui";
import { ago } from "./zoe-labels";
import {
  INPUT_SOURCES,
  METHODS,
  SECRET_FOR,
  blankDefinition,
  type ConnectorInput,
  type ConnectorOutput,
  type Definition,
} from "../lib/connector-definition";

/**
 * Train › Actions (phase 09, step D1; docs/ACTIONS_STEP1.md), while `ai_actions_v1` is on: Zoe's data
 * connectors. Each is edited as a draft, tested in the console (a job that calls the service with
 * sample values and shows the exact request and response, credentials masked), and published as
 * an immutable version. Credentials are write-only here. D3 (docs/ACTIONS_STEP3.md): a connector can
 * write (change things); Zoe uses one only after a manager turns its writes on, past a warning, and
 * the workspace's kill switch pauses every write at once.
 */
type Summary = {
  id: string;
  name: string;
  description: string;
  access: string;
  writesEnabled: boolean;
  method: string;
  liveVersion: number | null;
  changed: boolean;
  lastCall: { result: string; at: string } | null;
};
type Writes = { paused: boolean; by: string | null; at: string | null };
type Detail = {
  connector: {
    id: string;
    name: string;
    access: string;
    version: string;
    definition: Definition;
    liveVersion: number | null;
    changed: boolean;
    secrets: { name: string; hint: string; updatedAt: string }[];
    writes: { enabled: boolean; by: string | null; at: string | null };
    liveAccess: "read" | "write" | null;
  };
  paused: boolean;
  versions: { version: number; publishedAt: string; by: string | null }[];
  calls: {
    id: string;
    version: number | null;
    draft: boolean;
    by: string;
    conversationId: string | null;
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
    status: number | null;
    durationMs: number;
    result: string;
    error: string;
    at: string;
  }[];
};
type TestResult = {
  result: string;
  status: number | null;
  attempts: number;
  durationMs: number;
  outputs: Record<string, unknown>;
  error: string;
  request?: { method: string; url: string; headers: Record<string, string>; body: string | null };
  response?: { status: number; contentType: string; body: string; truncated: boolean };
};
export const RESULT_NAMES: Record<string, [string, string]> = {
  ok: ["Worked", "green"],
  http_error: ["Error from the service", "rose"],
  timeout: ["Timed out", "rose"],
  refused: ["Address refused", "rose"],
  invalid_input: ["Input not valid", "amber"],
  invalid_response: ["Unexpected response", "rose"],
  rate_limited: ["Over its rate limit", "amber"],
  auth_failed: ["Credentials refused", "rose"],
  unreachable: ["Couldn't reach it", "rose"],
};
const AUTH_NAMES: Record<Definition["auth"]["type"], string> = {
  none: "None",
  api_key: "API key in a header",
  bearer: "Bearer token",
  oauth_client_credentials: "OAuth 2 (client credentials)",
};
const SECRET_NAMES = { api_key: "API key", token: "Bearer token", client_secret: "Client secret" };
const Chip = ({ result }: { result: string }) => {
  const [label, hue] = RESULT_NAMES[result] ?? [result, "slate"];
  return (
    <span className="pg-zoe-review-why" data-hue={hue}>
      {label}
    </span>
  );
};

export function ActionsPage({ menu, page }: { menu: SideMenuState; page: Page }) {
  const [list, setList] = useState<Summary[] | null>(null);
  const [writes, setWrites] = useState<Writes | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () =>
    api<{ connectors: Summary[]; writes: Writes }>("zoe?view=connectors")
      .then((d) => {
        setList(d.connectors);
        setWrites(d.writes);
      })
      .catch((e) => setError(message(e, "This page could not be loaded.")));
  useEffect(() => {
    if (!open) void load();
  }, [open]);
  if (open)
    return (
      <Frame menu={menu} page={page} wide>
        <ConnectorEditor id={open} onBack={() => setOpen(null)} />
      </Frame>
    );
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <form
        className="pg-zoe-connector-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const d = await api<Detail>("zoe-connector", { action: "create", name });
            setName("");
            setOpen(d.connector.id);
          } catch (err) {
            setError(message(err, "The connector could not be created."));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="pg-settings-field">
          <span>New connector</span>
          <input value={name} maxLength={60} placeholder="Order lookup" onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" className="pg-zoe-primary" disabled={busy || !name.trim()}>
          <Plus size={14} aria-hidden="true" /> Create
        </button>
      </form>
      {list &&
        (list.length ? (
          <ul className="pg-zoe-monitors" aria-label="Connectors">
            {list.map((c) => (
              <li key={c.id} className="pg-zoe-monitor" aria-label={c.name}>
                <header>
                  <Plug size={16} aria-hidden="true" />
                  <strong>{c.name}</strong>
                  <span className="pg-zoe-review-why" data-hue={c.access === "write" ? "amber" : "sky"}>
                    {c.access === "write" ? `Write · ${c.method}${c.writesEnabled ? "" : " · off"}` : `Read · ${c.method}`}
                  </span>
                  <span className="pg-zoe-review-why" data-hue={c.liveVersion ? "green" : "slate"}>
                    {c.liveVersion ? `Live, version ${c.liveVersion}` : "Not published"}
                  </span>
                  {c.liveVersion && c.changed && (
                    <span className="pg-zoe-review-why" data-hue="amber">
                      Unpublished changes
                    </span>
                  )}
                </header>
                {c.description && <p className="pg-muted">{c.description}</p>}
                <div className="pg-zoe-review-actions">
                  {c.lastCall && (
                    <small className="pg-muted">
                      Last call {ago(c.lastCall.at)}: {RESULT_NAMES[c.lastCall.result]?.[0] ?? c.lastCall.result}
                    </small>
                  )}
                  <button type="button" className="pg-zoe-secondary" onClick={() => setOpen(c.id)}>
                    Open
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pg-zoe-empty">
            No connectors yet. A connector lets Zoe look things up in your systems, like an order or an
            account, with only the values you choose sent and returned.
          </p>
        ))}
      {writes && (
        <Card
          title="Write actions"
          description="Connectors that change things in your systems. Pausing stops every write at once, for Zoe and the test console, until you resume."
        >
          <div className="pg-zoe-review-actions">
            <span className="pg-zoe-review-why" data-hue={writes.paused ? "rose" : "green"}>
              {writes.paused ? "Paused" : "Allowed"}
            </span>
            {writes.by && writes.at && (
              <small className="pg-muted">
                {writes.paused ? "Paused" : "Resumed"} by {writes.by} {ago(writes.at)}
              </small>
            )}
            <button
              type="button"
              className={writes.paused ? "pg-zoe-primary" : "pg-zoe-secondary"}
              disabled={busy}
              onClick={async () => {
                if (!writes.paused && !window.confirm("Pause every write action now? Zoe hands over instead of changing anything.")) return;
                setBusy(true);
                setError("");
                try {
                  const d = await api<{ connectors: Summary[]; writes: Writes }>("zoe-connector", { action: "pause", paused: !writes.paused });
                  setList(d.connectors);
                  setWrites(d.writes);
                } catch (e) {
                  setError(message(e, "That could not be saved."));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {writes.paused ? "Resume write actions" : "Pause all write actions"}
            </button>
          </div>
        </Card>
      )}
    </Frame>
  );
}

function ConnectorEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [name, setName] = useState("");
  const [def, setDef] = useState<Definition>(blankDefinition());
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState("");
  const show = (d: Detail) => {
    setData(d);
    setName(d.connector.name);
    setDef(d.connector.definition);
  };
  const [tick, setTick] = useState(0);
  const load = () => setTick((n) => n + 1);
  useEffect(() => {
    api<Detail>(`zoe?view=connector&id=${encodeURIComponent(id)}`)
      .then((d) => {
        setData(d);
        // A reload after a test refreshes the calls, and keeps unsaved edits.
        if (tick === 0) {
          setName(d.connector.name);
          setDef(d.connector.definition);
        }
      })
      .catch((e) => setError(message(e, "This connector could not be loaded.")));
  }, [id, tick]);
  async function change(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const d = await api<Detail & { connectors?: unknown }>("zoe-connector", { id, ...body });
      if (body.action === "archive") return onBack();
      show(d);
      setStatus(done);
    } catch (e) {
      setError(message(e, "That could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return error ? (
      <p role="alert" className="pg-attr-error">
        {error}
      </p>
    ) : null;
  const c = data.connector;
  const dirty = name !== c.name || JSON.stringify(def) !== JSON.stringify(c.definition);
  const set = (patch: Partial<Definition>) => setDef((d) => ({ ...d, ...patch }));
  const secretName = SECRET_FOR[def.auth.type];
  const stored = c.secrets.find((s) => s.name === secretName);
  return (
    <section className="pg-zoe-connector" aria-label={`Connector ${c.name}`}>
      <div className="pg-zoe-review-actions">
        <button type="button" className="pg-link-button" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" /> All connectors
        </button>
      </div>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <p role="status" className="pg-muted pg-zoe-review-status">
        {status}
      </p>
      <header className="pg-zoe-connector-head">
        <label className="pg-settings-field">
          <span>Name</span>
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <span className="pg-zoe-review-why" data-hue={c.liveVersion ? "green" : "slate"}>
          {c.liveVersion ? `Live, version ${c.liveVersion}` : "Not published"}
        </span>
        {c.liveVersion && c.changed && !dirty && (
          <span className="pg-zoe-review-why" data-hue="amber">
            Unpublished changes
          </span>
        )}
        <div className="pg-zoe-review-actions">
          <button
            type="button"
            className="pg-zoe-secondary"
            disabled={busy || !dirty}
            onClick={() => void change({ action: "save", version: c.version, name, definition: def }, "Draft saved.")}
          >
            Save draft
          </button>
          <button
            type="button"
            className="pg-zoe-primary"
            disabled={busy || dirty || !c.changed}
            title={dirty ? "Save the draft first" : undefined}
            onClick={() => void change({ action: "publish", version: c.version }, "Published.")}
          >
            Publish
          </button>
          <button
            type="button"
            className="pg-zoe-secondary"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Archive ${c.name}? Zoe stops using it; its audit is kept.`))
                void change({ action: "archive", version: c.version }, "Archived.");
            }}
          >
            Archive
          </button>
        </div>
      </header>
      <p className="pg-muted">
        {def.access === "write"
          ? "Write: it changes things in your service. Zoe uses it only once its writes are on, only for signed-in customers, and (if you choose) after a teammate approves each one."
          : "Read only: it looks things up and changes nothing."}{" "}
        Conversations keep the version they started with; publishing changes what new conversations use.
      </p>

      {c.liveAccess === "write" && (
        <Card
          title="Writes"
          description={
            data.paused
              ? "Write actions are paused for the whole workspace: nothing is written until they're resumed under Actions."
              : "Whether Zoe may use this connector to change things."
          }
        >
          <div className="pg-zoe-review-actions">
            <span className="pg-zoe-review-why" data-hue={c.writes.enabled ? "amber" : "slate"}>
              {c.writes.enabled ? "Writes on" : "Writes off"}
            </span>
            {c.writes.enabled && c.writes.by && c.writes.at && (
              <small className="pg-muted">
                Turned on by {c.writes.by} {ago(c.writes.at)}
              </small>
            )}
            <button
              type="button"
              className={c.writes.enabled ? "pg-zoe-secondary" : "pg-zoe-primary"}
              disabled={busy}
              onClick={() => {
                if (c.writes.enabled) return void change({ action: "writes", version: c.version, enabled: false }, "Writes turned off.");
                if (
                  window.confirm(
                    `Turn on writes for ${c.name}? Zoe will be able to change things in this service for signed-in customers, in procedures you publish${def.approval === "always" ? ", after a teammate approves each one" : ", without asking a teammate"}.`,
                  )
                )
                  void change({ action: "writes", version: c.version, enabled: true, acknowledged: true }, "Writes turned on.");
              }}
            >
              {c.writes.enabled ? "Turn writes off" : "Turn writes on"}
            </button>
          </div>
        </Card>
      )}

      <Card title="Access" description="Whether it only looks things up, or changes things.">
        <div className="pg-zoe-connector-request">
          <select
            aria-label="Access"
            value={def.access ?? "read"}
            onChange={(e) => {
              const access = e.target.value as Definition["access"];
              set({ access, method: METHODS[access][0], retries: access === "write" ? 0 : def.retries });
            }}
          >
            <option value="read">Read: looks things up</option>
            <option value="write">Write: changes things</option>
          </select>
          {def.access === "write" && (
            <>
              <select aria-label="Approval" value={def.approval ?? "always"} onChange={(e) => set({ approval: e.target.value as Definition["approval"] })}>
                <option value="always">A teammate approves each write</option>
                <option value="never">No approval needed</option>
              </select>
              <input
                aria-label="Idempotency header"
                value={def.idempotencyHeader ?? ""}
                placeholder="Idempotency-Key (optional)"
                onChange={(e) => set({ idempotencyHeader: e.target.value })}
              />
            </>
          )}
        </div>
        {def.access === "write" && (
          <small className="pg-muted">
            With an idempotency header, Relay sends the same key on every attempt at one write, so it can retry safely. Without
            one, a write that may have gone through is never sent again.
          </small>
        )}
      </Card>

      <Card title="Description" description="What it does, in a sentence or two, for your team.">
        <textarea
          aria-label="Connector description"
          rows={2}
          maxLength={500}
          value={def.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </Card>

      <Card
        title="Inputs"
        description="Every value that may be sent, with where it comes from. Only these can appear in the request, as {{name}}."
      >
        <Rows
          label="Inputs"
          rows={def.inputs}
          onChange={(inputs) => set({ inputs })}
          blank={(): ConnectorInput => ({
            name: "",
            label: "",
            type: "string",
            source: "customer",
            required: true,
            sensitive: false,
            pattern: "",
            maxLength: 200,
          })}
          head={["Name", "Label", "Type", "Comes from", "Pattern", "Required", "Sensitive"]}
          cells={(r, up) => [
            <input key="n" aria-label="Input name" value={r.name} placeholder="order_id" onChange={(e) => up({ name: e.target.value })} />,
            <input key="l" aria-label="Input label" value={r.label} placeholder="Order number" onChange={(e) => up({ label: e.target.value })} />,
            <select key="t" aria-label="Input type" value={r.type} onChange={(e) => up({ type: e.target.value as ConnectorInput["type"] })}>
              <option value="string">Text</option>
              <option value="number">Number</option>
              <option value="boolean">True or false</option>
            </select>,
            <select key="s" aria-label="Input comes from" value={r.source} onChange={(e) => up({ source: e.target.value as ConnectorInput["source"] })}>
              {Object.entries(INPUT_SOURCES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>,
            <input key="p" aria-label="Input pattern" value={r.pattern} placeholder="[A-Z]\d{4}" onChange={(e) => up({ pattern: e.target.value })} />,
            <input key="r" type="checkbox" aria-label="Input required" checked={r.required} onChange={(e) => up({ required: e.target.checked })} />,
            <input key="x" type="checkbox" aria-label="Input sensitive" checked={r.sensitive} onChange={(e) => up({ sensitive: e.target.checked })} />,
          ]}
        />
        <small className="pg-muted">Sensitive inputs are redacted in the audit.</small>
      </Card>

      <Card title="Request" description="Where it goes. Relay only calls public https addresses, and never follows redirects.">
        <div className="pg-zoe-connector-request">
          <select aria-label="Method" value={def.method} onChange={(e) => set({ method: e.target.value as Definition["method"] })}>
            {METHODS[def.access ?? "read"].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input aria-label="Base address" value={def.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => set({ baseUrl: e.target.value })} />
          <input aria-label="Path" value={def.path} placeholder="/orders/{{order_id}}" onChange={(e) => set({ path: e.target.value })} />
        </div>
        <h4 className="pg-zoe-connector-sub">Query</h4>
        <Pairs label="Query values" rows={def.query} onChange={(query) => set({ query })} />
        <h4 className="pg-zoe-connector-sub">Headers</h4>
        <Pairs label="Headers" rows={def.headers} onChange={(headers) => set({ headers })} />
        {def.method !== "GET" && def.method !== "DELETE" && (
          <label className="pg-settings-field">
            <span>Body (JSON)</span>
            <textarea
              rows={4}
              className="pg-zoe-mono"
              value={def.body}
              placeholder={'{"order": "{{order_id}}"}'}
              onChange={(e) => set({ body: e.target.value })}
            />
          </label>
        )}
      </Card>

      <Card title="Authentication" description="Credentials are encrypted, never shown again, and masked in the test console.">
        <div className="pg-zoe-connector-request">
          <select
            aria-label="Authentication method"
            value={def.auth.type}
            onChange={(e) => {
              const type = e.target.value as Definition["auth"]["type"];
              set({
                auth:
                  type === "api_key"
                    ? { type, header: "X-Api-Key" }
                    : type === "oauth_client_credentials"
                      ? { type, tokenUrl: "https://", clientId: "", scope: "" }
                      : { type },
              });
            }}
          >
            {Object.entries(AUTH_NAMES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          {def.auth.type === "api_key" && (
            <input
              aria-label="API key header"
              value={def.auth.header}
              onChange={(e) => set({ auth: { type: "api_key", header: e.target.value } })}
            />
          )}
          {def.auth.type === "oauth_client_credentials" && (
            <>
              <input
                aria-label="Token address"
                value={def.auth.tokenUrl}
                onChange={(e) => set({ auth: { ...(def.auth as Extract<Definition["auth"], { type: "oauth_client_credentials" }>), tokenUrl: e.target.value } })}
              />
              <input
                aria-label="Client ID"
                value={def.auth.clientId}
                placeholder="Client ID"
                onChange={(e) => set({ auth: { ...(def.auth as Extract<Definition["auth"], { type: "oauth_client_credentials" }>), clientId: e.target.value } })}
              />
              <input
                aria-label="Scope"
                value={def.auth.scope}
                placeholder="Scope (optional)"
                onChange={(e) => set({ auth: { ...(def.auth as Extract<Definition["auth"], { type: "oauth_client_credentials" }>), scope: e.target.value } })}
              />
            </>
          )}
        </div>
        {secretName && (
          <form
            className="pg-zoe-connector-form"
            onSubmit={(e) => {
              e.preventDefault();
              void change({ action: "secret", name: secretName, value: secret }, `${SECRET_NAMES[secretName]} saved.`).then(() => setSecret(""));
            }}
          >
            <label className="pg-settings-field">
              <span>{SECRET_NAMES[secretName]}</span>
              <input
                type="password"
                autoComplete="off"
                value={secret}
                placeholder={stored ? `Set${stored.hint ? `, ending ${stored.hint}` : ""}. Paste to replace.` : "Paste it here"}
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
            <button type="submit" className="pg-zoe-secondary" disabled={busy || !secret.trim()}>
              {stored ? "Replace" : "Save"} {SECRET_NAMES[secretName]}
            </button>
          </form>
        )}
      </Card>

      <Card
        title="Response"
        description="The named values Zoe may use, picked out of the JSON response. She never sees anything else."
      >
        <Rows
          label="Outputs"
          rows={def.outputs}
          onChange={(outputs) => set({ outputs })}
          blank={(): ConnectorOutput => ({ name: "", label: "", path: "", type: "string", sensitive: false })}
          head={["Name", "Label", "Path in the response", "Type", "Sensitive"]}
          cells={(r, up) => [
            <input key="n" aria-label="Output name" value={r.name} placeholder="status" onChange={(e) => up({ name: e.target.value })} />,
            <input key="l" aria-label="Output label" value={r.label} placeholder="Status" onChange={(e) => up({ label: e.target.value })} />,
            <input key="p" aria-label="Output path" value={r.path} placeholder="order.status" onChange={(e) => up({ path: e.target.value })} />,
            <select key="t" aria-label="Output type" value={r.type} onChange={(e) => up({ type: e.target.value as ConnectorOutput["type"] })}>
              <option value="string">Text</option>
              <option value="number">Number</option>
              <option value="boolean">True or false</option>
              <option value="list">List</option>
            </select>,
            <input key="x" type="checkbox" aria-label="Output sensitive" checked={r.sensitive} onChange={(e) => up({ sensitive: e.target.checked })} />,
          ]}
        />
      </Card>

      <Card title="Limits" description="How long to wait, how often to retry a failure, and how often it may be called.">
        <div className="pg-zoe-connector-request">
          <label className="pg-settings-inline">
            Timeout (ms)
            <input type="number" min={1000} max={10000} step={500} value={def.timeoutMs} onChange={(e) => set({ timeoutMs: Number(e.target.value) })} />
          </label>
          <label className="pg-settings-inline">
            Retries
            <input type="number" min={0} max={2} value={def.retries} onChange={(e) => set({ retries: Number(e.target.value) })} />
          </label>
          <label className="pg-settings-inline">
            Calls a minute
            <input type="number" min={1} max={600} value={def.rateLimit} onChange={(e) => set({ rateLimit: Number(e.target.value) })} />
          </label>
        </div>
      </Card>

      <TestConsole id={id} def={c.definition} dirty={dirty} onDone={load} />

      <Card title="Recent calls" description="The audit: every call, with sensitive inputs redacted and only the named values.">
        {data.calls.length ? (
          <table className="pg-zoe-calls" aria-label="Recent calls">
            <thead>
              <tr>
                <th>When</th>
                <th>By</th>
                <th>Version</th>
                <th>Result</th>
                <th>Inputs</th>
                <th>Values</th>
              </tr>
            </thead>
            <tbody>
              {data.calls.map((k) => (
                <tr key={k.id}>
                  <td>{ago(k.at)}</td>
                  <td>{k.by}</td>
                  <td>{k.draft ? "Draft" : k.version}</td>
                  <td>
                    <Chip result={k.result} />
                    {k.status !== null && <small className="pg-muted"> {k.status}</small>}
                    {k.error && <small className="pg-muted"> {k.error}</small>}
                  </td>
                  <td className="pg-zoe-mono">{JSON.stringify(k.inputs)}</td>
                  <td className="pg-zoe-mono">{JSON.stringify(k.outputs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="pg-zoe-empty">No calls yet.</p>
        )}
      </Card>

      <Card title="Versions" description="Published versions are never changed.">
        {data.versions.length ? (
          <ul className="pg-settings-list" aria-label="Versions">
            {data.versions.map((v) => (
              <li key={v.version}>
                <span>
                  <strong>Version {v.version}</strong>
                  <small className="pg-muted">
                    Published {ago(v.publishedAt)}
                    {v.by ? ` by ${v.by}` : ""}
                  </small>
                </span>
                {v.version === c.liveVersion && (
                  <span className="pg-zoe-review-why" data-hue="green">
                    Live
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="pg-zoe-empty">Not published yet.</p>
        )}
      </Card>
    </section>
  );
}

function TestConsole({ id, def, dirty, onDone }: { id: string; def: Definition; dirty: boolean; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<TestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  async function run() {
    setRunning(true);
    setError("");
    setResult(null);
    try {
      const { jobId } = await api<{ jobId: string }>("zoe-connector", { action: "test", id, values });
      for (let i = 0; i < 60; i++) {
        const job = await api<{ state: string; result: TestResult | null }>("job?" + new URLSearchParams({ id: jobId }));
        if (job.state === "succeeded" && job.result) {
          setResult(job.result);
          onDone();
          return;
        }
        if (job.state === "dead_letter") throw new Error("The test couldn't run. Try again.");
        await new Promise((r) => setTimeout(r, i < 10 ? 400 : 1000));
      }
      throw new Error("The test is taking a long time. Its call will appear under Recent calls.");
    } catch (e) {
      setError(message(e, "The test couldn't run."));
    } finally {
      setRunning(false);
    }
  }
  return (
    <Card title="Test console" description="Calls the service with the saved draft and these sample values, and shows exactly what was sent and received.">
      {dirty && <p className="pg-muted">You have unsaved changes: the test uses the saved draft.</p>}
      <form
        className="pg-zoe-connector-request"
        aria-label="Sample values"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        {def.inputs.map((i) => (
          <label key={i.name} className="pg-settings-field">
            <span>{i.label}</span>
            <input
              value={values[i.name] ?? ""}
              placeholder={i.source === "customer" ? "" : INPUT_SOURCES[i.source]}
              onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))}
            />
          </label>
        ))}
        <button type="submit" className="pg-zoe-primary" disabled={running}>
          {running ? "Running…" : "Run test"}
        </button>
      </form>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {result && (
        <section className="pg-zoe-test-result" aria-label="Test result">
          <p>
            <Chip result={result.result} /> {result.status !== null && <span>Status {result.status}</span>} ·{" "}
            {result.durationMs} ms{result.attempts > 1 ? ` · ${result.attempts} attempts` : ""}
            {result.error && <span> · {result.error}</span>}
          </p>
          {result.request && (
            <Block title="Request">
              {`${result.request.method} ${result.request.url}\n${Object.entries(result.request.headers)
                .map(([k, v]) => `${k}: ${v}`)
                .join("\n")}${result.request.body ? `\n\n${result.request.body}` : ""}`}
            </Block>
          )}
          {result.response && (
            <Block title={`Response (${result.response.status}${result.response.truncated ? ", cut short" : ""})`}>
              {pretty(result.response.body) || "(empty)"}
            </Block>
          )}
          {result.result === "ok" && (
            <table className="pg-zoe-calls" aria-label="Values Zoe would get">
              <tbody>
                {def.outputs.map((o) => (
                  <tr key={o.name}>
                    <th>{o.label}</th>
                    <td className="pg-zoe-mono">{JSON.stringify(result.outputs[o.name] ?? null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </Card>
  );
}

/** JSON laid out to read; anything else as it came. */
function pretty(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pg-settings-code-block">
      <strong>{title}</strong>
      <pre className="pg-settings-code" aria-label={title}>
        {children}
      </pre>
    </div>
  );
}

function Rows<T>({
  label,
  rows,
  onChange,
  blank,
  head,
  cells,
}: {
  label: string;
  rows: T[];
  onChange: (rows: T[]) => void;
  blank: () => T;
  head: string[];
  cells: (row: T, update: (patch: Partial<T>) => void) => ReactNode[];
}) {
  return (
    <div className="pg-zoe-rows-wrap">
      {rows.length > 0 && (
        <table className="pg-zoe-rows" aria-label={label}>
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h}>{h}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {cells(r, (patch) => onChange(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)))).map((cell, k) => (
                  <td key={k}>{cell}</td>
                ))}
                <td>
                  <button
                    type="button"
                    className="pg-link-button"
                    aria-label={`Remove row ${i + 1}`}
                    onClick={() => onChange(rows.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" className="pg-zoe-secondary" onClick={() => onChange([...rows, blank()])}>
        <Plus size={14} aria-hidden="true" /> Add {label.toLowerCase().replace(/s$/, "")}
      </button>
    </div>
  );
}

function Pairs({
  label,
  rows,
  onChange,
}: {
  label: string;
  rows: { name: string; value: string }[];
  onChange: (rows: { name: string; value: string }[]) => void;
}) {
  return (
    <Rows
      label={label}
      rows={rows}
      onChange={onChange}
      blank={() => ({ name: "", value: "" })}
      head={["Name", "Value"]}
      cells={(r, up) => [
        <input key="n" aria-label={`${label} name`} value={r.name} onChange={(e) => up({ name: e.target.value })} />,
        <input key="v" aria-label={`${label} value`} value={r.value} onChange={(e) => up({ value: e.target.value })} />,
      ]}
    />
  );
}
