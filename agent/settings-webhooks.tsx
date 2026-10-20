import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";
import type { Topic } from "../lib/webhook-topics";

/**
 * Settings › Developers › Webhooks (phase 15, step D3; docs/DEVELOPER_PLATFORM_STEP3.md), behind
 * `developer_api_v1`, for who manages the workspace: subscriptions (an https address and topics),
 * each with its signing secret (shown once, and again only when rotated), and its delivery log:
 * every delivery's attempts, what came back, and the body, with a replay. The same functions serve
 * the API's /webhooks operations.
 */
type Webhook = {
  id: string;
  url: string;
  topics: string[];
  status: "active" | "failing" | "disabled";
  failing_since: string | null;
  disabled_reason: string | null;
  alert_email: string | null;
  previous_secret_until: string | null;
  created_at: string;
  secret?: string;
};
type Delivery = {
  id: string;
  event_id: string;
  topic: string;
  status: "pending" | "delivered" | "abandoned";
  attempts: number;
  next_attempt_at: string | null;
  last_status: number | null;
  last_error: string | null;
  replay_of: string | null;
  created_at: string;
  payload?: unknown;
  attempt_log?: { at: string; status: number | null; duration_ms: number; error: string | null; response: string }[];
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
const STATUS: Record<Webhook["status"], [string, string]> = { active: ["Active", "verified"], failing: ["Failing", "pending"], disabled: ["Off", "failed"] };
const DELIVERY: Record<Delivery["status"], [string, string]> = { delivered: ["Delivered", "verified"], pending: ["Retrying", "pending"], abandoned: ["Gave up", "failed"] };

export function WebhooksPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<{ webhooks: Webhook[]; topics: Topic[] } | null>(null);
  const [error, setError] = useState("");
  const [secret, setSecret] = useState<{ id: string; secret: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api<{ webhooks: Webhook[]; topics: Topic[] }>("developer-webhooks")
        .then(setData)
        .catch((e) => setError(message(e, "Webhooks couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (p: Record<string, unknown>, fallback: string) => {
    setError("");
    try {
      const r = await api<Webhook | Delivery>("developer-webhook", p);
      if ("secret" in r && r.secret) setSecret({ id: r.id, secret: r.secret });
      await load();
      return r;
    } catch (e) {
      setError(message(e, fallback));
      return null;
    }
  };
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {secret && (
        <Card title="Signing secret" description="Copy it now: it isn't shown again. Verify each delivery's Relay-Signature with it (the API reference shows how).">
          <p aria-label="Your webhook secret">
            <code>{secret.secret}</code>
          </p>
          <button type="button" className="pg-wf-link" onClick={() => setSecret(null)}>
            I’ve copied it
          </button>
        </Card>
      )}
      {data && (
        <>
          <Card title="Webhooks" description="Relay POSTs each event to your address, signed, at least once: retried for 24 hours, and turned off if it fails for 24 hours with no success.">
            {data.webhooks.length ? (
              <ul className="pg-webhooks">
                {data.webhooks.map((w) => (
                  <li key={w.id} aria-label={w.url}>
                    <div className="pg-webhook-head">
                      <span className="pg-email-status" data-status={STATUS[w.status][1]}>
                        {STATUS[w.status][0]}
                      </span>
                      <code className="pg-webhook-url">{w.url}</code>
                    </div>
                    <p className="pg-muted">
                      {w.topics.join(", ")}
                      {w.status === "failing" && ` · failing since ${when(w.failing_since)}`}
                      {w.status === "disabled" && w.disabled_reason ? ` · ${w.disabled_reason}` : ""}
                      {w.previous_secret_until ? ` · the previous secret also signs until ${when(w.previous_secret_until)}` : ""}
                    </p>
                    <div className="pg-webhook-actions">
                      <button type="button" className="pg-wf-link" aria-expanded={open === w.id} onClick={() => setOpen(open === w.id ? null : w.id)}>
                        {open === w.id ? "Hide deliveries" : "Deliveries"}
                      </button>
                      {w.status !== "disabled" && (
                        <button type="button" className="pg-wf-link" onClick={async () => (await act({ action: "test", id: w.id }, "The test couldn't be sent.")) && setOpen(w.id)}>
                          Send test
                        </button>
                      )}
                      <button type="button" className="pg-wf-link" onClick={() => void act({ action: "rotate", id: w.id }, "The secret couldn't be rotated.")}>
                        Rotate secret
                      </button>
                      <button type="button" className="pg-wf-link" onClick={() => void act({ action: "update", id: w.id, active: w.status === "disabled" }, "The webhook couldn't be changed.")}>
                        {w.status === "disabled" ? "Turn on" : "Turn off"}
                      </button>
                      <button type="button" className="pg-wf-link pg-danger-link" onClick={() => void act({ action: "delete", id: w.id }, "The webhook couldn't be deleted.")}>
                        Delete
                      </button>
                    </div>
                    {open === w.id && <Deliveries webhook={w} onReplay={(deliveryId) => act({ action: "replay", id: w.id, deliveryId }, "The delivery couldn't be replayed.")} />}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pg-muted">No webhooks yet.</p>
            )}
          </Card>
          <NewWebhook topics={data.topics} onCreate={(p) => act({ action: "create", ...p }, "The webhook couldn't be created.")} />
        </>
      )}
    </Frame>
  );
}

function NewWebhook({ topics, onCreate }: { topics: Topic[]; onCreate: (p: Record<string, unknown>) => Promise<unknown> }) {
  const [url, setUrl] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [alert, setAlert] = useState("");
  const groups = [...new Set(topics.map((t) => t.group))];
  return (
    <Card title="New webhook" description="An https address, and the topics to send it.">
      <label className="pg-settings-field">
        <span className="pg-settings-label">Address</span>
        <input type="url" placeholder="https://example.com/relay-webhooks" value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      {groups.map((g) => (
        <fieldset key={g} className="pg-settings-fieldset">
          <legend>{g}</legend>
          {topics
            .filter((t) => t.group === g)
            .map((t) => (
              <label key={t.id} className="pg-settings-toggle">
                <input type="checkbox" aria-label={t.id} checked={chosen.includes(t.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, t.id] : chosen.filter((x) => x !== t.id))} />
                <span>
                  <strong>{t.label}</strong>
                  <small className="pg-muted">
                    <code>{t.id}</code>
                  </small>
                </span>
              </label>
            ))}
        </fieldset>
      ))}
      <label className="pg-settings-field">
        <span className="pg-settings-label">Alert email (optional)</span>
        <input type="email" placeholder="Told if it's turned off after failing" value={alert} onChange={(e) => setAlert(e.target.value)} />
      </label>
      <button
        type="button"
        className="pg-primary"
        disabled={!url.trim() || !chosen.length}
        onClick={async () => {
          if (await onCreate({ url: url.trim(), topics: chosen, alert_email: alert.trim() || null })) {
            setUrl("");
            setChosen([]);
            setAlert("");
          }
        }}
      >
        Create webhook
      </button>
    </Card>
  );
}

function Deliveries({ webhook, onReplay }: { webhook: Webhook; onReplay: (deliveryId: string) => Promise<unknown> }) {
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [next, setNext] = useState<[string, string] | null>(null);
  const [detail, setDetail] = useState<Delivery | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    (after?: [string, string]) =>
      api<{ rows: Delivery[]; next: [string, string] | null }>(`developer-webhook-deliveries?id=${encodeURIComponent(webhook.id)}${after ? "&after=" + encodeURIComponent(JSON.stringify(after)) : ""}`).then(
        (r) => {
          setRows((now) => (after ? [...(now ?? []), ...r.rows] : r.rows));
          setNext(r.next);
        },
        (e) => setError(message(e, "Deliveries couldn't be loaded.")),
      ),
    [webhook.id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const show = async (d: Delivery) =>
    setDetail(await api<Delivery>(`developer-webhook-delivery?id=${encodeURIComponent(webhook.id)}&delivery=${encodeURIComponent(d.id)}`).catch(() => null));
  return (
    <div className="pg-webhook-log">
      <div className="pg-webhook-actions">
        <button type="button" className="pg-wf-link" onClick={() => void load()}>
          <RefreshCw size={12} aria-hidden="true" /> Refresh
        </button>
      </div>
      {error && <p className="pg-attr-error">{error}</p>}
      {rows && !rows.length && <p className="pg-muted">Nothing sent yet.</p>}
      {rows && rows.length > 0 && (
        <table className="pg-email-records pg-people-table" aria-label="Deliveries">
          <thead>
            <tr>
              <th scope="col">Sent</th>
              <th scope="col">Topic</th>
              <th scope="col">Status</th>
              <th scope="col">Attempts</th>
              <th scope="col">Last answer</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <th scope="row">
                  <button type="button" className="pg-wf-link" onClick={() => void show(d)}>
                    {when(d.created_at)}
                  </button>
                  {d.replay_of && <span className="pg-muted"> (replay)</span>}
                </th>
                <td>
                  <code>{d.topic}</code>
                </td>
                <td>
                  <span className="pg-email-status" data-status={DELIVERY[d.status][1]}>
                    {DELIVERY[d.status][0]}
                  </span>
                  {d.status === "pending" && d.attempts > 0 && <span className="pg-muted"> next {when(d.next_attempt_at)}</span>}
                </td>
                <td>{d.attempts}</td>
                <td>{d.last_status ?? (d.last_error ? "—" : "")}</td>
                <td>
                  <button type="button" className="pg-wf-link" onClick={() => void onReplay(d.id).then(() => load())}>
                    Replay
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next && (
        <button type="button" className="pg-wf-link" onClick={() => void load(next)}>
          Older deliveries
        </button>
      )}
      {detail && (
        <section className="pg-webhook-detail" aria-label="Delivery">
          <h4>
            {detail.topic} · event <code>{detail.event_id}</code>
          </h4>
          <ol>
            {(detail.attempt_log ?? []).map((a, i) => (
              <li key={i}>
                {when(a.at)} · {a.status ?? "no answer"} · {a.duration_ms} ms{a.error ? ` · ${a.error}` : ""}
                {a.response && <pre>{a.response}</pre>}
              </li>
            ))}
          </ol>
          <pre aria-label="Body sent">{JSON.stringify(detail.payload, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
