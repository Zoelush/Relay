import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Field, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › Events and Settings › Subscriptions (phase 13, step O1; docs/OUTBOUND_STEP1.md),
 * behind `segments_v1`, for workspace managers.
 * - Events: the names tracked (from the messenger's `Relay("track")` and your server), each
 *   described, archived (no longer kept) or tracked again; 120 at most.
 * - Subscriptions: the kinds of message people choose to get, opt-in or opt-out, per channel.
 *   Consent and channel are fixed once made (people chose on those terms); archiving one stops
 *   anything of its kind from being sent.
 */
type Events = { limit: number; tracked: number; events: { name: string; description: string; count: number; firstSeenAt: string; lastSeenAt: string; archived: boolean }[] };
type Subscriptions = {
  types: { id: string; name: string; description: string; consent: "opt_in" | "opt_out"; channel: string; archived: boolean; optedIn: number; optedOut: number }[];
  unsubscribedFromAll: number;
};
const CHANNELS: Record<string, string> = { email: "Email", sms: "SMS", whatsapp: "WhatsApp", in_app: "In-app" };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Load a page's data, and change it (a notice when done, the error when not). */
function usePage<T>(path: string, failure: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(
    () =>
      api<T>(path)
        .then(setData)
        .catch((e) => setError(message(e, failure))),
    [path, failure],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const change = async (body: Record<string, unknown>, done: string) => {
    setError("");
    setNotice("");
    try {
      setData(await api<T>(path, body));
      setNotice(done);
      return true;
    } catch (e) {
      setError(message(e, "That didn't work."));
      return false;
    }
  };
  const banners = (
    <>
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
    </>
  );
  return { data, change, banners };
}

export function EventsPage({ menu, page }: { menu: MenuState; page: Page }) {
  const { data, change, banners } = usePage<Events>("events-settings", "Events couldn't be loaded.");
  return (
    <Frame menu={menu} page={page}>
      {banners}
      {data && (
        <Card
          title={`Tracked events (${data.tracked} of ${data.limit})`}
          description={`What people do, sent by the messenger (Relay("track", {name, metadata}), for signed-in users) or by your server (POST /v1/events, signed with your identity key). Segments and outbound use them. An archived event is no longer kept.`}
        >
          {data.events.length ? (
            <ul className="pg-suppressions" aria-label="Events">
              {data.events.map((e) => (
                <EventRow key={e.name + e.description + e.archived} e={e} onChange={change} />
              ))}
            </ul>
          ) : (
            <p className="pg-muted">No events yet. They appear here the first time one is sent.</p>
          )}
        </Card>
      )}
    </Frame>
  );
}

function EventRow({ e, onChange }: { e: Events["events"][number]; onChange: (b: Record<string, unknown>, done: string) => Promise<boolean> }) {
  const [description, setDescription] = useState(e.description);
  return (
    <li>
      <div>
        <strong>{e.name}</strong>
        <span className="pg-muted">
          {e.count} {e.count === 1 ? "time" : "times"} · last {when(e.lastSeenAt)}
          {e.archived ? " · archived" : ""}
        </span>
        <form
          className="pg-settings-row"
          onSubmit={(ev) => {
            ev.preventDefault();
            void onChange({ action: "describe", name: e.name, description }, `Described ${e.name}.`);
          }}
        >
          <Field label={`Description of ${e.name}`}>{(id) => <input id={id} maxLength={300} placeholder="What it means" value={description} onChange={(x) => setDescription(x.target.value)} />}</Field>
          <button type="submit" className="pg-zoe-secondary">
            Save
          </button>
        </form>
      </div>
      <button
        type="button"
        className="pg-wf-link"
        aria-label={`${e.archived ? "Track" : "Archive"} ${e.name}`}
        onClick={() => void onChange({ action: e.archived ? "restore" : "archive", name: e.name }, e.archived ? `Tracking ${e.name} again.` : `Archived ${e.name}: it's no longer kept.`)}
      >
        {e.archived ? "Track again" : "Archive"}
      </button>
    </li>
  );
}

export function SubscriptionsPage({ menu, page }: { menu: MenuState; page: Page }) {
  const { data, change, banners } = usePage<Subscriptions>("subscription-settings", "Subscriptions couldn't be loaded.");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [consent, setConsent] = useState<"opt_in" | "opt_out">("opt_out");
  const [channel, setChannel] = useState("email");
  return (
    <Frame menu={menu} page={page}>
      {banners}
      {data && (
        <Card
          title="Subscription types"
          description="Every outbound message declares one, and nothing is sent to someone who said no: opt-in types only once they agree, opt-out types until they say no. People choose on the page every unsubscribe link opens. Replies in conversations they start aren't affected."
        >
          {data.types.length ? (
            <ul className="pg-suppressions" aria-label="Subscription types">
              {data.types.map((t) => (
                <TypeRow key={t.id + t.name + t.description + t.archived} t={t} onChange={change} />
              ))}
            </ul>
          ) : (
            <p className="pg-muted">No subscription types yet.</p>
          )}
          <p className="pg-muted">{data.unsubscribedFromAll} unsubscribed from everything.</p>
          <form
            className="pg-settings-row"
            aria-label="New subscription type"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await change({ action: "create", name, description, consent, channel }, `Created ${name}.`)) {
                setName("");
                setDescription("");
              }
            }}
          >
            <Field label="Name">{(id) => <input id={id} maxLength={80} placeholder="Product updates" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Description">{(id) => <input id={id} maxLength={300} placeholder="New features, once a month" value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
            <Field label="Consent">
              {(id) => (
                <select id={id} value={consent} onChange={(e) => setConsent(e.target.value as "opt_in" | "opt_out")}>
                  <option value="opt_out">Opt-out (sent until they say no)</option>
                  <option value="opt_in">Opt-in (sent once they agree)</option>
                </select>
              )}
            </Field>
            <Field label="Channel">
              {(id) => (
                <select id={id} value={channel} onChange={(e) => setChannel(e.target.value)}>
                  {Object.entries(CHANNELS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <button type="submit" className="pg-primary">
              Create
            </button>
          </form>
        </Card>
      )}
    </Frame>
  );
}

function TypeRow({ t, onChange }: { t: Subscriptions["types"][number]; onChange: (b: Record<string, unknown>, done: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(t.name);
  const [description, setDescription] = useState(t.description);
  return (
    <li>
      <div>
        <strong>
          {t.name}
          {t.archived ? " (archived)" : ""}
        </strong>
        <span className="pg-muted">
          {CHANNELS[t.channel]} · {t.consent === "opt_in" ? "opt-in" : "opt-out"} · {t.optedIn} chose in, {t.optedOut} chose out
          {t.description ? ` · ${t.description}` : ""}
        </span>
        {editing && (
          <form
            className="pg-settings-row"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await onChange({ action: "update", id: t.id, name, description }, `Saved ${name}.`)) setEditing(false);
            }}
          >
            <Field label="Name">{(id) => <input id={id} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Description">{(id) => <input id={id} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
            <button type="submit" className="pg-zoe-secondary">
              Save
            </button>
          </form>
        )}
      </div>
      {!t.archived && (
        <>
          <button type="button" className="pg-wf-link" aria-label={`Edit ${t.name}`} onClick={() => setEditing(!editing)}>
            {editing ? "Cancel" : "Edit"}
          </button>
          <button type="button" className="pg-wf-link" aria-label={`Archive ${t.name}`} onClick={() => void onChange({ action: "archive", id: t.id }, `Archived ${t.name}: nothing of its kind will be sent.`)}>
            Archive
          </button>
        </>
      )}
    </li>
  );
}
