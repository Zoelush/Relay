import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Field, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › Voice (phase 12, step E9; docs/OMNICHANNEL_STEP9.md): which of the SMS account's
 * numbers take calls (and buying another), recording consent by country, Zoe on the phone,
 * transcription, the voicemail greeting, how long each teammate is rung, teammates' phones for
 * transfers, and the latest calls.
 */
type Mode = "none" | "announce" | "consent";
type Data = {
  twilio: "pending" | "connected" | "failed" | null;
  brands: { id: string; name: string }[];
  settings: { zoe: boolean; recordingDefault: Mode; recordingOverrides: Record<string, Mode>; transcription: boolean; voicemailGreeting: string; ringSeconds: number };
  numbers: { id: string; phone: string; brandName: string; voice: boolean; error: string; connected: boolean }[];
  search: { country?: string; searching?: boolean; numbers?: { phone: string; locality: string }[]; error?: string; at: string | null };
  agents: { teammateId: string; name: string; phone: string | null; takesCalls: boolean }[];
  calls: { from: string; status: string; consent: string; recording: Mode; seconds: number | null; at: string; answered: boolean; voicemail: boolean }[];
};
const MODES: Record<Mode, string> = { none: "Don't record", announce: "Record, and say so", consent: "Ask first (press 1)" };
const STATUS: Record<string, string> = { in_progress: "On the call", completed: "Ended", busy: "Busy", no_answer: "No answer", failed: "Failed", canceled: "Hung up" };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
type Change = (body: Record<string, unknown>, done: string) => Promise<boolean>;

export function VoicePage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(
    () =>
      api<Data>("voice-settings")
        .then(setData)
        .catch((e) => setError(message(e, "Voice settings couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const change: Change = async (body, done) => {
    setError("");
    setNotice("");
    try {
      setData(await api<Data>("voice-settings", body));
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
      {data && data.twilio !== "connected" && <p className="pg-muted">Calls come through your Twilio account: connect it in Settings › SMS first.</p>}
      {data && <NumbersCard data={data} onChange={change} />}
      {data && <CallsSettingsCard key={JSON.stringify(data.settings)} data={data} onChange={change} />}
      {data && <AgentsCard data={data} onChange={change} />}
      {data && <RecentCard data={data} />}
    </Frame>
  );
}

function NumbersCard({ data, onChange }: { data: Data; onChange: Change }) {
  const [country, setCountry] = useState(data.search.country ?? "GB");
  const [brandId, setBrandId] = useState(data.brands[0]?.id ?? "");
  const [buying, setBuying] = useState<string | null>(null);
  return (
    <Card title="Numbers taking calls" description="Your SMS numbers can take calls too: switching one on points its calls at Relay. Buying a number adds it to your Twilio account (and Settings › SMS) for both.">
      {data.numbers.length ? (
        <ul className="pg-suppressions" aria-label="Numbers taking calls">
          {data.numbers.map((n) => (
            <li key={n.id}>
              <div>
                <strong>{n.phone}</strong>
                <span className="pg-muted">
                  {n.brandName}
                  {n.connected ? "" : " · not connected"}
                  {n.error ? ` · ${n.error}` : ""}
                </span>
              </div>
              <label className="pg-settings-toggle">
                <input
                  type="checkbox"
                  aria-label={`${n.phone} takes calls`}
                  disabled={!n.connected}
                  checked={n.voice}
                  onChange={(e) => void onChange({ action: "number", numberId: n.id, voice: e.target.checked }, e.target.checked ? `${n.phone} takes calls: this takes a moment.` : `${n.phone} no longer takes calls.`)}
                />{" "}
                Takes calls
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pg-muted">No numbers yet: add one in Settings › SMS, or buy one here.</p>
      )}
      <form
        className="pg-settings-row"
        aria-label="Find a number"
        onSubmit={(e) => {
          e.preventDefault();
          void onChange({ action: "search", country }, `Searching ${country.toUpperCase()}: this takes a moment.`);
        }}
      >
        <Field label="Country (two letters)">{(id) => <input id={id} maxLength={2} placeholder="GB" value={country} onChange={(e) => setCountry(e.target.value)} />}</Field>
        <button type="submit" className="pg-zoe-secondary">
          Find numbers
        </button>
      </form>
      {data.search.error && <p className="pg-attr-error">{data.search.error}</p>}
      {data.search.numbers && data.search.numbers.length > 0 && (
        <>
          <Field label="For the brand">
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
          <ul className="pg-suppressions" aria-label="Numbers you can buy">
            {data.search.numbers.map((n) => (
              <li key={n.phone}>
                <div>
                  <strong>{n.phone}</strong>
                  <span className="pg-muted">{n.locality || data.search.country}</span>
                </div>
                {buying === n.phone ? (
                  <>
                    <span className="pg-muted">Charged to your Twilio account.</span>
                    <button
                      type="button"
                      className="pg-primary"
                      onClick={async () => {
                        if (await onChange({ action: "buy", phone: n.phone, brandId, confirm: true }, `Buying ${n.phone}: this takes a moment.`)) setBuying(null);
                      }}
                    >
                      Confirm purchase
                    </button>
                    <button type="button" className="pg-wf-link" onClick={() => setBuying(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" className="pg-zoe-secondary" aria-label={`Buy ${n.phone}`} onClick={() => setBuying(n.phone)}>
                    Buy
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function CallsSettingsCard({ data, onChange }: { data: Data; onChange: Change }) {
  const s = data.settings;
  const [zoe, setZoe] = useState(s.zoe);
  const [mode, setMode] = useState<Mode>(s.recordingDefault);
  const [overrides, setOverrides] = useState<[string, Mode][]>(Object.entries(s.recordingOverrides));
  const [code, setCode] = useState("");
  const [codeMode, setCodeMode] = useState<Mode>("consent");
  const [transcription, setTranscription] = useState(s.transcription);
  const [greeting, setGreeting] = useState(s.voicemailGreeting);
  const [ring, setRing] = useState(String(s.ringSeconds));
  return (
    <Card title="Calls" description="Recording is by the caller's country: where the law asks for consent, ask first. Zoe answers, and calls are transcribed, only when the call is recorded.">
      <form
        className="pg-settings-stack"
        aria-label="Call settings"
        onSubmit={(e) => {
          e.preventDefault();
          void onChange(
            { action: "settings", zoe, recordingDefault: mode, recordingOverrides: Object.fromEntries(overrides), transcription, voicemailGreeting: greeting, ringSeconds: Number(ring) },
            "Call settings saved.",
          );
        }}
      >
        <Field label="Recording (every other country)">
          {(id) => (
            <select id={id} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              {(Object.keys(MODES) as Mode[]).map((m) => (
                <option key={m} value={m}>
                  {MODES[m]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {overrides.length > 0 && (
          <ul className="pg-suppressions" aria-label="Recording by country">
            {overrides.map(([c, m]) => (
              <li key={c}>
                <div>
                  <strong>+{c}</strong>
                  <span className="pg-muted">{MODES[m]}</span>
                </div>
                <button type="button" className="pg-wf-link" aria-label={`Remove +${c}`} onClick={() => setOverrides(overrides.filter(([k]) => k !== c))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="pg-settings-row">
          <Field label="Calling code">{(id) => <input id={id} placeholder="49" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />}</Field>
          <Field label="Recording there">
            {(id) => (
              <select id={id} value={codeMode} onChange={(e) => setCodeMode(e.target.value as Mode)}>
                {(Object.keys(MODES) as Mode[]).map((m) => (
                  <option key={m} value={m}>
                    {MODES[m]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <button
            type="button"
            className="pg-zoe-secondary"
            disabled={!code}
            onClick={() => {
              setOverrides([...overrides.filter(([k]) => k !== code), [code, codeMode]]);
              setCode("");
            }}
          >
            Add country
          </button>
        </div>
        <label className="pg-settings-toggle">
          <input type="checkbox" checked={zoe} onChange={(e) => setZoe(e.target.checked)} />
          <span>
            Zoe answers calls
            <small className="pg-muted">She hands over to the team when asked, after two silences, or after eight turns.</small>
          </span>
        </label>
        <label className="pg-settings-toggle">
          <input type="checkbox" checked={transcription} onChange={(e) => setTranscription(e.target.checked)} />
          <span>
            Transcribe recordings
            <small className="pg-muted">Calls and voicemails, into the conversation (for the team only).</small>
          </span>
        </label>
        <Field label="Voicemail greeting">
          {(id) => <textarea id={id} maxLength={500} rows={2} placeholder="No one can take your call right now. Please leave a message after the tone." value={greeting} onChange={(e) => setGreeting(e.target.value)} />}
        </Field>
        <Field label="Ring each teammate for (seconds)">{(id) => <input id={id} type="number" min={10} max={60} value={ring} onChange={(e) => setRing(e.target.value)} />}</Field>
        <div className="pg-settings-actions">
          <button type="submit" className="pg-primary">
            Save
          </button>
        </div>
      </form>
    </Card>
  );
}

function AgentsCard({ data, onChange }: { data: Data; onChange: Change }) {
  return (
    <Card title="Teammates who take calls" description="A transfer rings each one who takes calls and is active, in turn. They hear who's calling and why, and press 1 to take it.">
      <ul className="pg-suppressions" aria-label="Teammates' phones">
        {data.agents.map((a) => (
          <AgentRow key={a.teammateId + (a.phone ?? "")} agent={a} onChange={onChange} />
        ))}
      </ul>
    </Card>
  );
}

function AgentRow({ agent, onChange }: { agent: Data["agents"][number]; onChange: Change }) {
  const [phone, setPhone] = useState(agent.phone ?? "");
  const [takes, setTakes] = useState(agent.phone ? agent.takesCalls : true);
  return (
    <li>
      <form
        className="pg-settings-row"
        aria-label={`${agent.name}'s phone`}
        onSubmit={(e) => {
          e.preventDefault();
          void onChange({ action: "agent", teammateId: agent.teammateId, phone, takesCalls: takes }, `Saved ${agent.name}'s phone.`);
        }}
      >
        <strong>{agent.name}</strong>
        <Field label="Phone">{(id) => <input id={id} placeholder="+44 7700 900999" value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
        <label className="pg-settings-toggle">
          <input type="checkbox" checked={takes} onChange={(e) => setTakes(e.target.checked)} /> Takes calls
        </label>
        <button type="submit" className="pg-zoe-secondary">
          Save
        </button>
      </form>
    </li>
  );
}

function RecentCard({ data }: { data: Data }) {
  return (
    <Card title="Recent calls" description="The latest 20. Each call is a conversation in the inbox, with its recording and transcript when it was recorded.">
      {data.calls.length ? (
        <table className="pg-email-records" aria-label="Recent calls">
          <tbody>
            {data.calls.map((c, i) => (
              <tr key={i}>
                <th scope="row">{c.from}</th>
                <td>{when(c.at)}</td>
                <td>
                  {STATUS[c.status] ?? c.status}
                  {c.seconds ? ` · ${c.seconds}s` : ""}
                </td>
                <td>{c.answered ? "Answered by the team" : c.voicemail ? "Voicemail" : ""}</td>
                <td>{c.recording === "none" ? "Not recorded" : c.recording === "announce" || c.consent === "granted" ? "Recorded" : c.consent === "declined" ? "Declined recording" : "Not recorded"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="pg-muted">No calls yet.</p>
      )}
    </Card>
  );
}
