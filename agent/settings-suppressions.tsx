import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Field, Frame, message, type MenuState, type Page } from "./settings-ui";
import { channelLabel } from "../lib/channels";

/**
 * Settings › Suppression list (phase 12, step E1; docs/OMNICHANNEL_STEP1.md): addresses nothing is
 * sent to, on any channel with addresses, through any path. Hard bounces, complaints and opt-outs
 * are added by the channels; managers add blocks by hand. A manual block or a hard bounce can be
 * lifted; an opt-out or a complaint can't (only the customer can opt back in).
 */
type Entry = {
  id: string;
  channel: string;
  address: string;
  reason: "manual" | "hard_bounce" | "complaint" | "opt_out";
  source: string;
  note: string;
  createdAt: string;
  createdBy: string | null;
  liftedAt: string | null;
  liftedBy: string | null;
  liftable: boolean;
};
type Data = { entries: Entry[]; channels: { id: string; address: string }[] };
const REASONS: Record<Entry["reason"], string> = {
  manual: "Blocked by a teammate",
  hard_bounce: "Hard bounce",
  complaint: "Complaint",
  opt_out: "Opted out",
};
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function SuppressionsPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState("");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [find, setFind] = useState("");
  const load = useCallback(
    () =>
      api<Data>("suppressions")
        .then((d) => {
          setData(d);
          setChannel((c) => c || d.channels[0]?.id || "");
        })
        .catch((e) => setError(message(e, "The list couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const change = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setData(await api<Data>("suppression", body));
      setNotice(done);
      return true;
    } catch (e) {
      setError(message(e, "That didn't work."));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const q = find.trim().toLowerCase();
  const shown = (data?.entries ?? []).filter((e) => !q || e.address.includes(q));
  const active = shown.filter((e) => !e.liftedAt);
  const lifted = shown.filter((e) => e.liftedAt);
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
      <Card title="Block an address" description="Nothing is sent to a blocked address on its channel: not replies, workflows, Zoe or notifications.">
        {data && !data.channels.length ? (
          <p className="pg-muted">No channel with addresses yet: email arrives next (phase 12). The list works across channels as they join.</p>
        ) : (
          <form
            className="pg-settings-row"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await change({ action: "add", channel, address, note }, `Blocked ${address.trim()}.`)) {
                setAddress("");
                setNote("");
              }
            }}
          >
            <Field label="Channel">
              {(id) => (
                <select id={id} value={channel} onChange={(e) => setChannel(e.target.value)}>
                  {data?.channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {channelLabel(c.id)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Address">
              {(id) => <input id={id} required value={address} onChange={(e) => setAddress(e.target.value)} />}
            </Field>
            <Field label="Note (optional)">
              {(id) => <input id={id} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <button type="submit" className="pg-primary" disabled={busy || !address.trim() || !channel}>
              Block
            </button>
          </form>
        )}
      </Card>
      <Card title="Suppressed addresses" description="Opt-outs and complaints stay until the customer opts back in; a manual block or a hard bounce can be lifted.">
        <input type="search" aria-label="Find an address" placeholder="Find an address" value={find} onChange={(e) => setFind(e.target.value)} />
        {data && !active.length ? (
          <p className="pg-muted">{q ? "No address matches." : "Nothing is suppressed."}</p>
        ) : (
          <ul className="pg-suppressions" aria-label="Suppressed addresses">
            {active.map((e) => (
              <li key={e.id}>
                <div>
                  <strong>{e.address}</strong>
                  <span className="pg-muted">
                    {channelLabel(e.channel)} · {REASONS[e.reason]} · {when(e.createdAt)}
                    {e.createdBy ? ` by ${e.createdBy}` : ""}
                    {e.note ? ` · “${e.note}”` : ""}
                  </span>
                </div>
                {e.liftable && (
                  <button type="button" className="pg-zoe-secondary" disabled={busy} onClick={() => void change({ action: "lift", id: e.id }, `Lifted ${e.address}.`)}>
                    Lift
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {lifted.length > 0 && (
          <details>
            <summary>Lifted ({lifted.length})</summary>
            <ul className="pg-suppressions">
              {lifted.map((e) => (
                <li key={e.id}>
                  <div>
                    <span>{e.address}</span>
                    <span className="pg-muted">
                      {channelLabel(e.channel)} · {REASONS[e.reason]} · lifted {when(e.liftedAt!)}
                      {e.liftedBy ? ` by ${e.liftedBy}` : ""}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>
    </Frame>
  );
}
