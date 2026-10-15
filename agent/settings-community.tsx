import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Field, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › Slack & Discord (phase 12, step E8; docs/OMNICHANNEL_STEP8.md): a Slack workspace
 * (the workspace's own Slack app: its bot token and signing secret) or a Discord server (its
 * bot's token), connected for a brand. Tokens are never shown again. Slack's events come to the
 * URL shown; Discord's messages come over its gateway, whose state is shown.
 */
type Connection = {
  id: string;
  platform: "slack" | "discord";
  brandName: string;
  externalId: string;
  name: string;
  tokenHint: string;
  status: "pending" | "connected" | "failed";
  error: string;
  gateway: { state: string; at: string | null } | null;
  checkedAt: string | null;
};
type Data = { platforms: { slack: boolean; discord: boolean }; slackEventsUrl: string; brands: { id: string; name: string }[]; connections: Connection[] };
const STATUS = { pending: "Checking", connected: "Connected", failed: "Not connected" } as const;
const pill = (s: string) => (s === "connected" ? "verified" : s === "failed" ? "failed" : "pending");
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
type Change = (body: Record<string, unknown>, done: string) => Promise<boolean>;

export function CommunityPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(
    () =>
      api<Data>("community-settings")
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
      setData(await api<Data>("community-settings", body));
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
      {data?.connections.map((c) => <ConnectionCard key={c.id} c={c} eventsUrl={data.slackEventsUrl} onChange={change} />)}
      {data?.platforms.slack && <ConnectSlack brands={data.brands} eventsUrl={data.slackEventsUrl} onChange={change} />}
      {data?.platforms.discord && <ConnectDiscord brands={data.brands} onChange={change} />}
    </Frame>
  );
}

function ConnectionCard({ c, eventsUrl, onChange }: { c: Connection; eventsUrl: string; onChange: Change }) {
  const label = c.platform === "slack" ? "Slack" : "Discord";
  return (
    <Card title={`${c.brandName}: ${label} · ${c.name || "checking…"}`} description={c.platform === "slack" ? `Events come to ${eventsUrl}.` : "Messages come over Discord's gateway."}>
      <p aria-label={`Status of ${label} ${c.name || c.id}`}>
        <span className="pg-email-status" data-status={pill(c.status)}>
          {STATUS[c.status]}
        </span>{" "}
        <span className="pg-muted">
          Token ending {c.tokenHint}
          {c.checkedAt ? ` · checked ${when(c.checkedAt)}` : ""}
          {c.gateway ? ` · gateway: ${c.gateway.state || "not started"}${c.gateway.at ? ` (${when(c.gateway.at)})` : ""}` : ""}
        </span>
      </p>
      {c.error && <p className="pg-attr-error">{c.error}</p>}
      <span className="pg-wf-inline">
        <button type="button" className="pg-zoe-secondary" onClick={() => void onChange({ action: "check", connectionId: c.id }, "Checking: this takes a moment.")}>
          Check again
        </button>
        <button type="button" className="pg-zoe-secondary" onClick={() => void onChange({ action: "disconnect", connectionId: c.id }, `Disconnected ${label}.`)}>
          Disconnect
        </button>
      </span>
    </Card>
  );
}

function BrandField({ brands, value, onChange }: { brands: { id: string; name: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Brand">
      {(id) => (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function ConnectSlack({ brands, eventsUrl, onChange }: { brands: { id: string; name: string }[]; eventsUrl: string; onChange: Change }) {
  const [f, setF] = useState({ brandId: brands[0]?.id ?? "", token: "", signingSecret: "" });
  return (
    <Card
      title="Connect a Slack workspace"
      description={`Your Slack app's bot token (scopes: channels:history, groups:history, im:history, chat:write, users:read, files:read) and its signing secret. Point Event Subscriptions at ${eventsUrl} and subscribe to message.channels, message.groups and message.im; invite the bot to the channels to watch.`}
    >
      <form
        className="pg-side-dialog"
        aria-label="Connect Slack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await onChange({ action: "connect", platform: "slack", ...f }, "Checking Slack: this takes a moment.")) setF({ ...f, token: "", signingSecret: "" });
        }}
      >
        <BrandField brands={brands} value={f.brandId} onChange={(brandId) => setF({ ...f, brandId })} />
        <Field label="Bot token">{(id) => <input id={id} type="password" autoComplete="off" placeholder="xoxb-…" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />}</Field>
        <Field label="Signing secret">{(id) => <input id={id} type="password" autoComplete="off" value={f.signingSecret} onChange={(e) => setF({ ...f, signingSecret: e.target.value })} />}</Field>
        <span>
          <button type="submit" className="pg-primary">
            Connect Slack
          </button>
        </span>
      </form>
    </Card>
  );
}

function ConnectDiscord({ brands, onChange }: { brands: { id: string; name: string }[]; onChange: Change }) {
  const [f, setF] = useState({ brandId: brands[0]?.id ?? "", token: "" });
  return (
    <Card
      title="Connect a Discord server"
      description="Your Discord bot's token (Developer Portal › Bot), with the Message Content intent switched on, and the bot added to your server with Read Messages and Send Messages."
    >
      <form
        className="pg-side-dialog"
        aria-label="Connect Discord"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await onChange({ action: "connect", platform: "discord", ...f }, "Checking Discord: this takes a moment.")) setF({ ...f, token: "" });
        }}
      >
        <BrandField brands={brands} value={f.brandId} onChange={(brandId) => setF({ ...f, brandId })} />
        <Field label="Bot token">{(id) => <input id={id} type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />}</Field>
        <span>
          <button type="submit" className="pg-primary">
            Connect Discord
          </button>
        </span>
      </form>
    </Card>
  );
}
