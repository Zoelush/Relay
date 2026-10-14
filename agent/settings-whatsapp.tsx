import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Field, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › WhatsApp (phase 12, step E5; docs/OMNICHANNEL_STEP5.md): a brand's WhatsApp Business
 * number, connected with the workspace's own Meta app (its ids, access token and app secret, never
 * shown again), the webhook to set up at Meta, message templates (submitted for Meta's review,
 * with their status), and opt-ins (recorded when a customer writes, or by a teammate with where
 * consent was given).
 */
type WaNumber = {
  id: string;
  brandId: string;
  brandName: string;
  phoneNumberId: string;
  wabaId: string;
  displayNumber: string;
  verifiedName: string;
  quality: string;
  status: "pending" | "connected" | "failed";
  error: string;
  tokenHint: string;
  webhook: { url: string; verifyToken: string };
  checkedAt: string | null;
};
type Template = { id: string; numberId: string; name: string; language: string; category: string; body: string; params: number; status: string; reason: string };
type Data = { brands: { id: string; name: string }[]; numbers: WaNumber[]; templates: Template[]; optIns: { phone: string; source: string; at: string }[] };
const STATUS = { pending: "Checking with Meta", connected: "Connected", failed: "Not connected" } as const;
const TEMPLATE_STATUS: Record<string, string> = { pending: "In review", approved: "Approved", rejected: "Rejected", paused: "Paused", disabled: "Disabled" };
const SOURCES: Record<string, string> = { customer_message: "They wrote to you", recorded: "Recorded by a teammate", keyword: "They sent START" };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const copy = (v: string) => void navigator.clipboard?.writeText(v).catch(() => {});

export function WhatsAppPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(
    () =>
      api<Data>("whatsapp-settings")
        .then(setData)
        .catch((e) => setError(message(e, "WhatsApp settings couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const change = async (body: Record<string, unknown>, done: string) => {
    setError("");
    setNotice("");
    try {
      setData(await api<Data>("whatsapp-settings", body));
      setNotice(done);
      return true;
    } catch (e) {
      setError(message(e, "That didn't work."));
      return false;
    }
  };
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="pg-muted">
          {notice}
          {notice.includes("moment") && (
            <>
              {" "}
              <button type="button" className="pg-wf-link" onClick={() => void load()}>
                Refresh
              </button>
            </>
          )}
        </p>
      )}
      {data?.numbers.map((n) => (
        <NumberCard key={n.id} n={n} templates={data.templates.filter((t) => t.numberId === n.id)} onChange={change} />
      ))}
      {data && <ConnectCard brands={data.brands} onChange={change} first={!data.numbers.length} />}
      {data && <OptInsCard optIns={data.optIns} onChange={change} />}
    </Frame>
  );
}

type Change = (body: Record<string, unknown>, done: string) => Promise<boolean>;

function NumberCard({ n, templates, onChange }: { n: WaNumber; templates: Template[]; onChange: Change }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Card title={`${n.brandName}: ${n.displayNumber || n.phoneNumberId}`} description={n.verifiedName ? `Shown to customers as “${n.verifiedName}”.` : "WhatsApp Business number."}>
      <p aria-label={`Status of ${n.displayNumber || n.phoneNumberId}`}>
        <span className="pg-email-status" data-status={n.status === "connected" ? "verified" : n.status === "failed" ? "failed" : "pending"}>
          {STATUS[n.status]}
        </span>{" "}
        <span className="pg-muted">
          {n.quality ? `Quality: ${n.quality.toLowerCase()}. ` : ""}
          {n.checkedAt ? `Checked ${when(n.checkedAt)}.` : ""} Token ending {n.tokenHint}.
        </span>
      </p>
      {n.error && <p className="pg-attr-error">{n.error}</p>}
      <div className="pg-email-records-wrap">
        <table className="pg-email-records" aria-label="Webhook to set up at Meta">
          <tbody>
            <tr>
              <th scope="row">Callback URL</th>
              <td>
                <code>{n.webhook.url}</code>{" "}
                <button type="button" className="pg-wf-link" aria-label="Copy the callback URL" onClick={() => copy(n.webhook.url)}>
                  Copy
                </button>
              </td>
            </tr>
            <tr>
              <th scope="row">Verify token</th>
              <td>
                <code>{n.webhook.verifyToken}</code>{" "}
                <button type="button" className="pg-wf-link" aria-label="Copy the verify token" onClick={() => copy(n.webhook.verifyToken)}>
                  Copy
                </button>
              </td>
            </tr>
            <tr>
              <th scope="row">Fields</th>
              <td>
                Subscribe to <code>messages</code> and <code>message_template_status_update</code>.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <span className="pg-wf-inline">
        <button type="button" className="pg-zoe-secondary" onClick={() => void onChange({ action: "check", numberId: n.id }, "Checking with Meta: this takes a moment.")}>
          Check again
        </button>
        {confirming ? (
          <>
            <span className="pg-muted">Nothing more is sent or received on it.</span>
            <button type="button" className="pg-primary" onClick={() => void onChange({ action: "disconnect", numberId: n.id }, "Disconnected.")}>
              Disconnect
            </button>
            <button type="button" className="pg-zoe-secondary" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="pg-zoe-secondary" onClick={() => setConfirming(true)}>
            Disconnect…
          </button>
        )}
      </span>
      <Templates n={n} templates={templates} onChange={onChange} />
    </Card>
  );
}

/** Message templates: the only thing that may be sent once a conversation's 24-hour window has closed. */
function Templates({ n, templates, onChange }: { n: WaNumber; templates: Template[]; onChange: Change }) {
  const [draft, setDraft] = useState({ name: "", language: "en", category: "utility", body: "", examples: [] as string[] });
  const count = new Set([...draft.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
  return (
    <section className="pg-email-sending" aria-label={`Templates for ${n.displayNumber || n.phoneNumberId}`}>
      <h3>Message templates</h3>
      <p className="pg-muted">Once a customer hasn&apos;t written for 24 hours, only an approved template can be sent to them. Meta reviews each one.</p>
      {templates.length ? (
        <ul className="pg-suppressions" aria-label="Templates">
          {templates.map((t) => (
            <li key={t.id}>
              <div>
                <strong>
                  {t.name} <span className="pg-muted">({t.language}, {t.category})</span>
                </strong>
                <span className="pg-muted">{t.body}</span>
                {t.reason && <span className="pg-muted">{t.reason}</span>}
              </div>
              <span className="pg-email-status" data-status={t.status === "approved" ? "verified" : t.status === "pending" ? "pending" : "failed"}>
                {TEMPLATE_STATUS[t.status] ?? t.status}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pg-muted">No templates yet.</p>
      )}
      <button type="button" className="pg-wf-link" onClick={() => void onChange({ action: "sync", numberId: n.id }, "Fetching their status from Meta: this takes a moment.")}>
        Update their status from Meta
      </button>
      <details>
        <summary>New template</summary>
        <form
          className="pg-side-dialog"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await onChange({ action: "template", numberId: n.id, ...draft, examples: draft.examples.slice(0, count) }, `Sent ${draft.name} to Meta for review.`))
              setDraft({ name: "", language: "en", category: "utility", body: "", examples: [] });
          }}
        >
          <div className="pg-settings-row">
            <Field label="Name">{(id) => <input id={id} placeholder="order_update" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}</Field>
            <Field label="Language">{(id) => <input id={id} value={draft.language} onChange={(e) => setDraft({ ...draft, language: e.target.value })} />}</Field>
            <Field label="Category">
              {(id) => (
                <select id={id} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                  <option value="utility">Utility</option>
                  <option value="marketing">Marketing</option>
                  <option value="authentication">Authentication</option>
                </select>
              )}
            </Field>
          </div>
          <Field label="Text (values as {{1}}, {{2}})">
            {(id) => <textarea id={id} rows={3} maxLength={1024} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />}
          </Field>
          {[...Array(count)].map((_, i) => (
            <Field key={i} label={`Example for {{${i + 1}}}`}>
              {(id) => (
                <input
                  id={id}
                  value={draft.examples[i] ?? ""}
                  onChange={(e) => {
                    const examples = [...draft.examples];
                    examples[i] = e.target.value;
                    setDraft({ ...draft, examples });
                  }}
                />
              )}
            </Field>
          ))}
          <span>
            <button type="submit" className="pg-primary">
              Send for review
            </button>
          </span>
        </form>
      </details>
    </section>
  );
}

function ConnectCard({ brands, onChange, first }: { brands: { id: string; name: string }[]; onChange: Change; first: boolean }) {
  const [f, setF] = useState({ brandId: brands[0]?.id ?? "", phoneNumberId: "", wabaId: "", token: "", appSecret: "" });
  return (
    <Card
      title={first ? "Connect a WhatsApp number" : "Connect another number"}
      description="From your Meta app (WhatsApp › API setup): the phone number ID, the WhatsApp Business account ID, a system user's access token, and the app secret (App settings › Basic). The token and secret are stored encrypted and never shown again."
    >
      <form
        className="pg-side-dialog"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await onChange({ action: "connect", ...f }, "Checking with Meta: this takes a moment.")) setF({ ...f, phoneNumberId: "", wabaId: "", token: "", appSecret: "" });
        }}
      >
        <div className="pg-settings-row">
          <Field label="Brand">
            {(id) => (
              <select id={id} value={f.brandId} onChange={(e) => setF({ ...f, brandId: e.target.value })}>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Phone number ID">{(id) => <input id={id} inputMode="numeric" value={f.phoneNumberId} onChange={(e) => setF({ ...f, phoneNumberId: e.target.value })} />}</Field>
          <Field label="WhatsApp Business account ID">{(id) => <input id={id} inputMode="numeric" value={f.wabaId} onChange={(e) => setF({ ...f, wabaId: e.target.value })} />}</Field>
        </div>
        <Field label="Access token">{(id) => <input id={id} type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />}</Field>
        <Field label="App secret">{(id) => <input id={id} type="password" autoComplete="off" value={f.appSecret} onChange={(e) => setF({ ...f, appSecret: e.target.value })} />}</Field>
        <span>
          <button type="submit" className="pg-primary">
            Connect
          </button>
        </span>
      </form>
    </Card>
  );
}

/** Who may be sent a template: those who wrote to you, sent START, or whose consent a teammate recorded. */
function OptInsCard({ optIns, onChange }: { optIns: Data["optIns"]; onChange: Change }) {
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  return (
    <Card title="Opt-ins" description="A template goes only to a number that opted in. Writing to you counts; so does consent given elsewhere, recorded here with where. Anyone who sends STOP is sent nothing more until they send START.">
      <form
        className="pg-settings-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await onChange({ action: "opt_in", phone, note }, `Recorded ${phone}'s opt-in.`)) {
            setPhone("");
            setNote("");
          }
        }}
      >
        <Field label="Phone number">{(id) => <input id={id} placeholder="+44 7700 900456" value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
        <Field label="Where they gave consent">{(id) => <input id={id} placeholder="Checkout form, 14 Oct" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <button type="submit" className="pg-zoe-secondary">
          Record opt-in
        </button>
      </form>
      {optIns.length ? (
        <ul className="pg-suppressions" aria-label="Opted-in numbers">
          {optIns.map((o) => (
            <li key={o.phone}>
              <div>
                <strong>{o.phone}</strong>
                <span className="pg-muted">
                  {SOURCES[o.source] ?? o.source} · {when(o.at)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pg-muted">No one has opted in yet.</p>
      )}
    </Card>
  );
}
