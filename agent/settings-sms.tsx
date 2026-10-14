import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Field, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › SMS (phase 12, step E6; docs/OMNICHANNEL_STEP6.md): the workspace's Twilio account
 * (its SID and auth token, never shown again), each brand's numbers (one per country: a reply goes
 * from the number in the customer's country), what a segment costs to each country (for the
 * composer's estimate), the reply to HELP, and consent to be texted.
 */
type Data = {
  account: { sid: string; tokenHint: string; friendlyName: string; status: "pending" | "connected" | "failed"; error: string; helpReply: string; checkedAt: string | null } | null;
  webhook: string;
  brands: { id: string; name: string }[];
  numbers: { id: string; brandId: string; brandName: string; phone: string; callingCode: string; isDefault: boolean; status: "pending" | "connected" | "failed"; error: string }[];
  prices: { callingCode: string; perSegment: number; currency: string }[];
  defaultPrices: Record<string, number>;
  consents: { phone: string; source: string; note: string; at: string }[];
};
const STATUS = { pending: "Checking with Twilio", connected: "Connected", failed: "Not connected" } as const;
const SOURCES: Record<string, string> = { customer_message: "They texted you", recorded: "Recorded by a teammate", keyword: "They texted START" };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const pill = (s: string) => (s === "connected" ? "verified" : s === "failed" ? "failed" : "pending");
type Change = (body: Record<string, unknown>, done: string) => Promise<boolean>;

export function SmsPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(
    () =>
      api<Data>("sms-settings")
        .then(setData)
        .catch((e) => setError(message(e, "SMS settings couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const change: Change = async (body, done) => {
    setError("");
    setNotice("");
    try {
      setData(await api<Data>("sms-settings", body));
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
          {notice}{" "}
          {notice.includes("moment") && (
            <button type="button" className="pg-wf-link" onClick={() => void load()}>
              Refresh
            </button>
          )}
        </p>
      )}
      {data && <AccountCard data={data} onChange={change} />}
      {data?.account && <NumbersCard data={data} onChange={change} />}
      {data?.account && <PricesCard data={data} onChange={change} />}
      {data && <ConsentCard data={data} onChange={change} />}
    </Frame>
  );
}

function AccountCard({ data, onChange }: { data: Data; onChange: Change }) {
  const a = data.account;
  const [sid, setSid] = useState("");
  const [token, setToken] = useState("");
  const [help, setHelp] = useState(a?.helpReply ?? "");
  return (
    <Card title="Twilio account" description="Texts go through your own Twilio account. Its auth token is stored encrypted and never shown again; it also proves Twilio's calls to Relay are Twilio's.">
      {a && (
        <p aria-label="Twilio account status">
          <span className="pg-email-status" data-status={pill(a.status)}>
            {STATUS[a.status]}
          </span>{" "}
          <span className="pg-muted">
            {a.friendlyName ? `${a.friendlyName} · ` : ""}
            {a.sid} · token ending {a.tokenHint}
            {a.checkedAt ? ` · checked ${when(a.checkedAt)}` : ""}
          </span>
        </p>
      )}
      {a?.error && <p className="pg-attr-error">{a.error}</p>}
      <form
        className="pg-settings-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await onChange({ action: "connect", sid: sid.trim(), token: token.trim() }, "Checking with Twilio: this takes a moment.")) {
            setSid("");
            setToken("");
          }
        }}
      >
        <Field label="Account SID">{(id) => <input id={id} placeholder="AC…" autoComplete="off" value={sid} onChange={(e) => setSid(e.target.value)} />}</Field>
        <Field label="Auth token">{(id) => <input id={id} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />}</Field>
        <button type="submit" className={a ? "pg-zoe-secondary" : "pg-primary"}>
          {a ? "Replace" : "Connect"}
        </button>
      </form>
      {a && (
        <form
          className="pg-settings-row"
          onSubmit={(e) => {
            e.preventDefault();
            void onChange({ action: "help", helpReply: help }, "HELP reply saved.");
          }}
        >
          <Field label="Reply to HELP (must say how to opt out)">
            {(id) => <input id={id} maxLength={320} placeholder="Acme support: reply here and we'll answer. Reply STOP to opt out." value={help} onChange={(e) => setHelp(e.target.value)} />}
          </Field>
          <button type="submit" className="pg-zoe-secondary">
            Save
          </button>
        </form>
      )}
    </Card>
  );
}

function NumbersCard({ data, onChange }: { data: Data; onChange: Change }) {
  const [phone, setPhone] = useState("");
  const [brandId, setBrandId] = useState(data.brands[0]?.id ?? "");
  const [isDefault, setDefault] = useState(false);
  return (
    <Card title="Numbers" description={`Each brand's numbers in your Twilio account, one per country: a reply goes from the number in the customer's country, else the brand's default. Adding one points its incoming texts at ${data.webhook}.`}>
      {data.numbers.length ? (
        <ul className="pg-suppressions" aria-label="SMS numbers">
          {data.numbers.map((n) => (
            <li key={n.id}>
              <div>
                <strong>
                  {n.phone} <span className="pg-muted">(+{n.callingCode})</span>
                </strong>
                <span className="pg-muted">
                  {n.brandName}
                  {n.isDefault ? " · default" : ""}
                  {n.error ? ` · ${n.error}` : ""}
                </span>
              </div>
              <span className="pg-email-status" data-status={pill(n.status)}>
                {STATUS[n.status]}
              </span>
              <button type="button" className="pg-wf-link" aria-label={`Remove ${n.phone}`} onClick={() => void onChange({ action: "remove", numberId: n.id }, `Removed ${n.phone}.`)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pg-muted">No numbers yet.</p>
      )}
      <form
        className="pg-settings-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await onChange({ action: "number", phone, brandId, isDefault }, `Adding ${phone}: this takes a moment.`)) setPhone("");
        }}
      >
        <Field label="Number (with country code)">{(id) => <input id={id} placeholder="+44 7700 900100" value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
        <Field label="Brand">
          {(id) => (
            <select id={id} value={brandId} onChange={(e) => setBrandId(e.target.value)}>
              {data.brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <label className="pg-settings-toggle">
          <input type="checkbox" checked={isDefault} onChange={(e) => setDefault(e.target.checked)} /> The brand&apos;s default
        </label>
        <button type="submit" className="pg-zoe-secondary">
          Add number
        </button>
      </form>
    </Card>
  );
}

function PricesCard({ data, onChange }: { data: Data; onChange: Change }) {
  const [code, setCode] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("USD");
  const own = new Map(data.prices.map((p) => [p.callingCode, p]));
  const codes = [...new Set([...data.prices.map((p) => p.callingCode), ...data.numbers.map((n) => n.callingCode)])].sort();
  return (
    <Card title="What a text costs" description="Per segment, by country, for the composer's estimate. Where you haven't set one, a rough figure in US dollars is used (marked as an estimate); your Twilio invoice is the bill.">
      {codes.length > 0 && (
        <table className="pg-email-records" aria-label="Prices per segment">
          <tbody>
            {codes.map((c) => (
              <tr key={c}>
                <th scope="row">+{c}</th>
                <td>{own.get(c) ? `${own.get(c)!.perSegment} ${own.get(c)!.currency}` : data.defaultPrices[c] !== undefined ? `about ${data.defaultPrices[c]} USD (estimate)` : "No estimate"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="pg-settings-row"
        onSubmit={(e) => {
          e.preventDefault();
          void onChange({ action: "price", callingCode: code, perSegment: Number(price), currency }, `Saved the price for +${code.replace(/^\+/, "")}.`);
        }}
      >
        <Field label="Calling code">{(id) => <input id={id} placeholder="44" value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
        <Field label="Per segment">{(id) => <input id={id} inputMode="decimal" placeholder="0.04" value={price} onChange={(e) => setPrice(e.target.value)} />}</Field>
        <Field label="Currency">{(id) => <input id={id} maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value)} />}</Field>
        <button type="submit" className="pg-zoe-secondary">
          Save price
        </button>
      </form>
    </Card>
  );
}

function ConsentCard({ data, onChange }: { data: Data; onChange: Change }) {
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  return (
    <Card title="Consent" description="A number is texted only when it texted you first, or its consent was given elsewhere and recorded here. STOP (and its local equivalents) opts it out until it texts START.">
      <form
        className="pg-settings-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await onChange({ action: "consent", phone, note }, `Recorded consent for ${phone}.`)) {
            setPhone("");
            setNote("");
          }
        }}
      >
        <Field label="Phone number">{(id) => <input id={id} placeholder="+44 7700 900456" value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
        <Field label="Where they agreed">{(id) => <input id={id} placeholder="Signup form, 14 Oct" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <button type="submit" className="pg-zoe-secondary">
          Record consent
        </button>
      </form>
      {data.consents.length ? (
        <ul className="pg-suppressions" aria-label="Numbers that agreed to texts">
          {data.consents.map((c) => (
            <li key={c.phone}>
              <div>
                <strong>{c.phone}</strong>
                <span className="pg-muted">
                  {SOURCES[c.source] ?? c.source}
                  {c.note ? ` (${c.note})` : ""} · {when(c.at)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pg-muted">No consent recorded yet.</p>
      )}
    </Card>
  );
}
