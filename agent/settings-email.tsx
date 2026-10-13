import { useCallback, useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { api } from "./api";
import { Card, Field, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › Email (phase 12, step E2; docs/OMNICHANNEL_STEP2.md): each brand's inbound address,
 * the brand's own support address that forwards to it, whether forwarding is confirmed (a
 * forwarded message arrived), Gmail's forwarding confirmation when it comes, and the latest mail.
 * Sending (the brand's domain, SPF, DKIM and DMARC) is E3's.
 */
type Brand = {
  brandId: string;
  name: string;
  address: string;
  supportAddress: string | null;
  forwardingVerifiedAt: string | null;
  confirmation: { subject: string; text: string; receivedAt: string } | null;
};
type Data = {
  brands: Brand[];
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
