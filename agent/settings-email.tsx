import { useCallback, useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { api } from "./api";
import { Card, Field, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › Email (phase 12, steps E2 and E3; docs/OMNICHANNEL_STEP2.md and STEP3.md): each
 * brand's inbound address, the brand's own support address that forwards to it, whether
 * forwarding is confirmed (a forwarded message arrived), Gmail's forwarding confirmation when it
 * comes, and the latest mail. E3: where replies go from, the domain's records (ownership, DKIM,
 * SPF, DMARC) with their status, the sending rate, away emails, and each domain's reputation.
 */
type DomainRecord = {
  purpose: "ownership" | "dkim" | "bounce_mx" | "spf" | "dmarc";
  type: string;
  name: string;
  value: string;
  required: boolean;
  status: "ok" | "missing" | "wrong" | "unknown";
  found?: string;
};
type Sending = {
  from: string;
  domain: {
    name: string;
    freeMail: boolean;
    status: "pending" | "verified" | "failed" | null;
    error: string;
    records: DomainRecord[];
    ratePerMinute: number;
    checkedAt: string | null;
  } | null;
  away: { enabled: boolean; content: boolean; minutes: number };
};
type Reputation = {
  domain: string;
  shared: boolean;
  days: 7 | 30;
  sent: number;
  delivered: number;
  bounces: number;
  complaints: number;
  bounceRate: number;
  complaintRate: number;
  standing: "healthy" | "at_risk" | "poor" | "too_few";
  daily: { day: string; sent: number; bounced: number }[];
};
type Brand = {
  brandId: string;
  name: string;
  address: string;
  supportAddress: string | null;
  forwardingVerifiedAt: string | null;
  confirmation: { subject: string; text: string; receivedAt: string } | null;
  sending: Sending;
};
type Data = {
  brands: Brand[];
  reputation: Reputation[];
  recent: { brandId: string; status: string; kind: string | null; error: string; from: string; receivedAt: string }[];
};
const KINDS: Record<string, string> = { message: "Message", auto_reply: "Automatic reply", bounce: "Bounce", confirmation: "Forwarding confirmation" };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function EmailPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(
    () =>
      api<Data>("email-settings")
        .then(setData)
        .catch((e) => setError(message(e, "Email settings couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const change = async (body: Record<string, unknown>, done: string) => {
    setError("");
    setNotice("");
    try {
      setData(await api<Data>("email-settings", body));
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
        </p>
      )}
      {data?.brands.map((b) => (
        <BrandEmail key={b.brandId} brand={b} onChange={change} />
      ))}
      {data && <ReputationCard reputation={data.reputation} />}
      <Card title="Latest mail" description="The last 20 emails received at your inbound addresses, and what became of each.">
        {data && !data.recent.length ? (
          <p className="pg-muted">Nothing received yet.</p>
        ) : (
          <ul className="pg-suppressions" aria-label="Latest mail">
            {data?.recent.map((r, i) => (
              <li key={i}>
                <div>
                  <strong>{r.kind ? KINDS[r.kind] : r.status === "received" ? "Being read" : "Not read"}</strong>
                  <span className="pg-muted">
                    {data.brands.find((b) => b.brandId === r.brandId)?.name ?? r.brandId} · {when(r.receivedAt)}
                    {r.error ? ` · ${r.error}` : ""}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Frame>
  );
}

function BrandEmail({ brand, onChange }: { brand: Brand; onChange: (body: Record<string, unknown>, done: string) => Promise<boolean> }) {
  const [support, setSupport] = useState(brand.supportAddress ?? "");
  const [confirming, setConfirming] = useState(false);
  return (
    <Card title={`${brand.name}: email`} description="Customers write to your own support address; it forwards here, and each email becomes a conversation (or joins its thread).">
      <div className="pg-settings-row">
        <Field label="Relay's inbound address">
          {(id) => <input id={id} readOnly value={brand.address} onFocus={(e) => e.currentTarget.select()} />}
        </Field>
        <button type="button" className="pg-zoe-secondary" onClick={() => void navigator.clipboard?.writeText(brand.address).catch(() => {})}>
          <Copy size={14} aria-hidden="true" /> Copy
        </button>
      </div>
      <form
        className="pg-settings-row"
        onSubmit={(e) => {
          e.preventDefault();
          void onChange({ action: "save", brandId: brand.brandId, supportAddress: support }, support.trim() ? `Saved ${support.trim()}.` : "Support address removed.");
        }}
      >
        <Field label="Your support address">
          {(id) => <input id={id} placeholder="support@yourcompany.com" value={support} onChange={(e) => setSupport(e.target.value)} />}
        </Field>
        <button type="submit" className="pg-primary">
          Save
        </button>
      </form>
      {brand.supportAddress && (
        <p className="pg-muted" role="status" aria-label={`Forwarding for ${brand.name}`}>
          {brand.forwardingVerifiedAt
            ? `Forwarding from ${brand.supportAddress} is working (confirmed ${when(brand.forwardingVerifiedAt)}).`
            : `Waiting for an email forwarded from ${brand.supportAddress}. Set up forwarding, then send it a test.`}
        </p>
      )}
      {brand.confirmation && (
        <div className="pg-email-blocked" aria-label="Gmail forwarding confirmation">
          <strong>Gmail asked to confirm forwarding</strong> ({when(brand.confirmation.receivedAt)}): enter its code in Gmail, or open its link.
          <pre className="pg-email-text">{brand.confirmation.text}</pre>
        </div>
      )}
      <details>
        <summary>How to forward your support address here</summary>
        <ul className="pg-email-files">
          <li>Gmail or Google Workspace: Settings › Forwarding and POP/IMAP › Add a forwarding address. Gmail sends a confirmation here, which shows on this page.</li>
          <li>Outlook or Microsoft 365: a mail flow rule (or Forwarding in the mailbox&apos;s settings) to the inbound address.</li>
          <li>Anything else: forward, or redirect, every message to the inbound address. Keep the original sender.</li>
        </ul>
      </details>
      <SendingSection brand={brand} onChange={onChange} />
      <AwaySection brand={brand} onChange={onChange} />
      {confirming ? (
        <span className="pg-wf-inline">
          <span className="pg-muted">The current address stops accepting mail at once.</span>
          <button
            type="button"
            className="pg-primary"
            onClick={() => void onChange({ action: "new_address", brandId: brand.brandId }, "A new inbound address is ready: update your forwarding.").then(() => setConfirming(false))}
          >
            Make a new address
          </button>
          <button type="button" className="pg-zoe-secondary" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button type="button" className="pg-zoe-secondary" onClick={() => setConfirming(true)}>
          New inbound address
        </button>
      )}
    </Card>
  );
}

const PURPOSE: Record<DomainRecord["purpose"], string> = {
  ownership: "Relay ownership",
  dkim: "DKIM",
  bounce_mx: "Bounces (MX)",
  spf: "SPF",
  dmarc: "DMARC",
};
const RECORD_STATUS: Record<DomainRecord["status"], string> = {
  ok: "Found",
  missing: "Not found",
  wrong: "Different value",
  unknown: "Not checked",
};
const DOMAIN_STATUS = {
  verified: "Sending from your domain",
  pending: "Waiting for DNS",
  failed: "Not proven",
} as const;
type Change = (body: Record<string, unknown>, done: string) => Promise<boolean>;

/** Where replies go from, and the records that let them go from the brand's own domain. */
function SendingSection({ brand, onChange }: { brand: Brand; onChange: Change }) {
  const d = brand.sending.domain;
  const [rate, setRate] = useState(String(d?.ratePerMinute ?? 60));
  return (
    <section className="pg-email-sending" aria-label={`Sending for ${brand.name}`}>
      <h3>Sending</h3>
      <p>
        Replies go from <strong>{brand.sending.from}</strong>
        {d?.status !== "verified" && <span className="pg-muted"> (Relay&apos;s address for {brand.name}, until your domain is proven)</span>}.
      </p>
      {!d ? (
        <p className="pg-muted">Save your support address to send from your own domain.</p>
      ) : d.freeMail ? (
        <p className="pg-muted">Replies can&apos;t go from {d.name}: it&apos;s a mailbox anyone can sign up for. They go from Relay&apos;s address instead.</p>
      ) : (
        <>
          <p>
            <span className="pg-email-status" data-status={d.status ?? "pending"}>
              {DOMAIN_STATUS[d.status ?? "pending"]}
            </span>{" "}
            <span className="pg-muted">
              {d.checkedAt ? `Checked ${when(d.checkedAt)}.` : "Not checked yet."} Add these records at your DNS provider; DKIM&apos;s appear after the first check.
            </span>
          </p>
          {d.error && <p className="pg-muted">{d.error}</p>}
          <div className="pg-email-records-wrap">
            <table className="pg-email-records" aria-label={`DNS records for ${d.name}`}>
              <thead>
                <tr>
                  <th scope="col">Record</th>
                  <th scope="col">Type</th>
                  <th scope="col">Name</th>
                  <th scope="col">Value</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {d.records.map((r) => (
                  <tr key={r.purpose + r.name}>
                    <td>
                      {PURPOSE[r.purpose]}
                      {!r.required && <span className="pg-muted"> (advised)</span>}
                    </td>
                    <td>{r.type}</td>
                    <td>
                      <code>{r.name}</code>
                    </td>
                    <td>
                      <code>{r.value}</code>{" "}
                      <button
                        type="button"
                        className="pg-wf-link"
                        aria-label={`Copy the ${PURPOSE[r.purpose]} value`}
                        onClick={() => void navigator.clipboard?.writeText(r.value).catch(() => {})}
                      >
                        Copy
                      </button>
                    </td>
                    <td className="pg-email-record-status" data-status={r.status}>
                      {RECORD_STATUS[r.status]}
                      {r.found ? `: ${r.found}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pg-settings-row">
            <button
              type="button"
              className="pg-zoe-secondary"
              onClick={() => void onChange({ action: "check_domain", brandId: brand.brandId }, `Checking ${d.name}: this takes a moment.`)}
            >
              Check now
            </button>
            <form
              className="pg-settings-row"
              onSubmit={(e) => {
                e.preventDefault();
                void onChange(
                  {
                    action: "rate",
                    brandId: brand.brandId,
                    perMinute: Number(rate),
                  },
                  `${d.name} sends at most ${rate} emails a minute.`,
                );
              }}
            >
              <Field label="Emails a minute, at most">{(id) => <input id={id} type="number" min={1} max={10000} value={rate} onChange={(e) => setRate(e.target.value)} />}</Field>
              <button type="submit" className="pg-zoe-secondary">
                Save rate
              </button>
            </form>
          </div>
        </>
      )}
    </section>
  );
}

/** Messenger customers who don't read a reply get an email of it. */
function AwaySection({ brand, onChange }: { brand: Brand; onChange: Change }) {
  const [away, setAway] = useState(brand.sending.away);
  return (
    <form
      className="pg-email-sending"
      aria-label={`Away emails for ${brand.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        void onChange({ action: "away", brandId: brand.brandId, ...away }, away.enabled ? "Away emails saved." : "Away emails are off.");
      }}
    >
      <h3>Away emails</h3>
      <label className="pg-settings-toggle">
        <input type="checkbox" checked={away.enabled} onChange={(e) => setAway({ ...away, enabled: e.target.checked })} /> Email messenger customers the replies they haven&apos;t
        read
      </label>
      <div className="pg-settings-row">
        <Field label="After (minutes)">
          {(id) => (
            <input id={id} type="number" min={1} max={1440} value={away.minutes} disabled={!away.enabled} onChange={(e) => setAway({ ...away, minutes: Number(e.target.value) })} />
          )}
        </Field>
      </div>
      <label className="pg-settings-toggle">
        <input type="checkbox" checked={away.content} disabled={!away.enabled} onChange={(e) => setAway({ ...away, content: e.target.checked })} /> Include the replies themselves
        <span className="pg-muted"> (off: the email only says there&apos;s a reply)</span>
      </label>
      <button type="submit" className="pg-zoe-secondary">
        Save away emails
      </button>
    </form>
  );
}

const STANDING = {
  healthy: "Healthy",
  at_risk: "At risk",
  poor: "Poor",
  too_few: "Too few emails to judge",
} as const;
const pct = (n: number) => `${(n * 100).toFixed(n > 0 && n < 0.01 ? 2 : 1)}%`;
/** Each sending domain's last 7 and 30 days, against the provider's review levels. */
function ReputationCard({ reputation }: { reputation: Reputation[] }) {
  const domains = [...new Set(reputation.map((r) => r.domain))];
  return (
    <Card
      title="Sending reputation"
      description="Bounces and spam complaints for each domain replies go from. At 5% bounces or 0.1% complaints a domain is at risk; at 10% or 0.5%, providers may stop it sending."
    >
      {!domains.length ? (
        <p className="pg-muted">No email sent in the last 30 days.</p>
      ) : (
        domains.map((domain) => {
          const week = reputation.find((r) => r.domain === domain && r.days === 7)!;
          const month = reputation.find((r) => r.domain === domain && r.days === 30)!;
          const top = Math.max(1, ...month.daily.map((d) => d.sent));
          return (
            <section key={domain} className="pg-email-reputation" aria-label={`Reputation of ${domain}`}>
              <h3>
                {domain}
                {month.shared && <span className="pg-muted"> (Relay&apos;s address)</span>}{" "}
                <span className="pg-email-status" data-standing={month.standing}>
                  {STANDING[month.standing]}
                </span>
              </h3>
              <table className="pg-email-records">
                <thead>
                  <tr>
                    <th scope="col">Period</th>
                    <th scope="col">Sent</th>
                    <th scope="col">Delivered</th>
                    <th scope="col">Bounced</th>
                    <th scope="col">Complaints</th>
                  </tr>
                </thead>
                <tbody>
                  {[week, month].map((r) => (
                    <tr key={r.days}>
                      <th scope="row">Last {r.days} days</th>
                      <td>{r.sent}</td>
                      <td>{r.delivered}</td>
                      <td>
                        {r.bounces} ({pct(r.bounceRate)})
                      </td>
                      <td>
                        {r.complaints} ({pct(r.complaintRate)})
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="pg-email-daily" role="img" aria-label={`Emails sent each day for 30 days from ${domain}, with bounces`}>
                {month.daily.map((d) => (
                  <span key={d.day} title={`${d.day}: ${d.sent} sent, ${d.bounced} bounced`} style={{ height: `${Math.max(4, (d.sent / top) * 100)}%` }}>
                    {d.bounced > 0 && (
                      <i
                        style={{
                          height: `${(d.bounced / Math.max(1, d.sent)) * 100}%`,
                        }}
                      />
                    )}
                  </span>
                ))}
              </div>
            </section>
          );
        })
      )}
    </Card>
  );
}
