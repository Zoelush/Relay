import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Field, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › Instagram & Facebook (phase 12, step E7; docs/OMNICHANNEL_STEP7.md): a brand's
 * Facebook Page (its Messenger) and the Instagram business account linked to it, connected with
 * the workspace's own Meta app (the Page's access token and the app secret, never shown again),
 * and the webhook to set up at Meta.
 */
type MetaPageRow = {
  id: string;
  brandName: string;
  pageId: string;
  pageName: string;
  instagram: { id: string; username: string } | null;
  tokenHint: string;
  status: "pending" | "connected" | "failed";
  error: string;
  checkedAt: string | null;
  webhook: { url: string; verifyToken: string };
};
type Data = { platforms: { facebook: boolean; instagram: boolean }; brands: { id: string; name: string }[]; pages: MetaPageRow[] };
const STATUS = { pending: "Checking with Meta", connected: "Connected", failed: "Not connected" } as const;
const pill = (s: string) => (s === "connected" ? "verified" : s === "failed" ? "failed" : "pending");
const copy = (v: string) => void navigator.clipboard?.writeText(v).catch(() => {});
type Change = (body: Record<string, unknown>, done: string) => Promise<boolean>;

export function MetaPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(
    () =>
      api<Data>("meta-settings")
        .then(setData)
        .catch((e) => setError(message(e, "These settings couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const change: Change = async (body, done) => {
    setError("");
    setNotice("");
    try {
      setData(await api<Data>("meta-settings", body));
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
      {data?.pages.map((p) => <PageCard key={p.id} p={p} platforms={data.platforms} onChange={change} />)}
      {data && <ConnectCard brands={data.brands} first={!data.pages.length} onChange={change} />}
    </Frame>
  );
}

function PageCard({ p, platforms, onChange }: { p: MetaPageRow; platforms: Data["platforms"]; onChange: Change }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Card title={`${p.brandName}: ${p.pageName || p.pageId}`} description={p.instagram ? `With Instagram @${p.instagram.username}.` : "No Instagram account is linked to this Page."}>
      <p aria-label={`Status of ${p.pageName || p.pageId}`}>
        <span className="pg-email-status" data-status={pill(p.status)}>
          {STATUS[p.status]}
        </span>{" "}
        <span className="pg-muted">
          {platforms.facebook ? "Messenger on" : "Messenger off"} · {platforms.instagram ? "Instagram on" : "Instagram off"} · token ending {p.tokenHint}
        </span>
      </p>
      {p.error && <p className="pg-attr-error">{p.error}</p>}
      <div className="pg-email-records-wrap">
        <table className="pg-email-records" aria-label="Webhook to set up at Meta">
          <tbody>
            <tr>
              <th scope="row">Callback URL</th>
              <td>
                <code>{p.webhook.url}</code>{" "}
                <button type="button" className="pg-wf-link" aria-label="Copy the callback URL" onClick={() => copy(p.webhook.url)}>
                  Copy
                </button>
              </td>
            </tr>
            <tr>
              <th scope="row">Verify token</th>
              <td>
                <code>{p.webhook.verifyToken}</code>{" "}
                <button type="button" className="pg-wf-link" aria-label="Copy the verify token" onClick={() => copy(p.webhook.verifyToken)}>
                  Copy
                </button>
              </td>
            </tr>
            <tr>
              <th scope="row">Fields</th>
              <td>
                Page: <code>messages</code>, <code>message_deliveries</code>, <code>message_reads</code>, <code>message_echoes</code>. Instagram: <code>messages</code>.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <span className="pg-wf-inline">
        <button type="button" className="pg-zoe-secondary" onClick={() => void onChange({ action: "check", pageId: p.id }, "Checking with Meta: this takes a moment.")}>
          Check again
        </button>
        {confirming ? (
          <>
            <span className="pg-muted">Nothing more is sent or received on it.</span>
            <button type="button" className="pg-primary" onClick={() => void onChange({ action: "disconnect", pageId: p.id }, "Disconnected.")}>
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
    </Card>
  );
}

function ConnectCard({ brands, first, onChange }: { brands: { id: string; name: string }[]; first: boolean; onChange: Change }) {
  const [f, setF] = useState({ brandId: brands[0]?.id ?? "", pageId: "", token: "", appSecret: "" });
  return (
    <Card
      title={first ? "Connect a Facebook Page" : "Connect another Page"}
      description="From your Meta app: the Page ID, a Page access token from a system user (with pages_messaging, and instagram_manage_messages for Instagram), and the app secret. Link the Instagram business account to the Page in Meta first; it's found from the Page."
    >
      <form
        className="pg-side-dialog"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await onChange({ action: "connect", ...f }, "Checking with Meta: this takes a moment.")) setF({ ...f, pageId: "", token: "", appSecret: "" });
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
          <Field label="Page ID">{(id) => <input id={id} inputMode="numeric" value={f.pageId} onChange={(e) => setF({ ...f, pageId: e.target.value })} />}</Field>
        </div>
        <Field label="Page access token">{(id) => <input id={id} type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />}</Field>
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
