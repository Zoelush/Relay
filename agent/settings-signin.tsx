import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Phase 16, step C3a (docs/SECURITY_STEP3.md), behind `security_v1`:
 * - **Your sign-in** (every teammate): a password to sign in with (set, or changed with the
 *   current one; a new password signs out every other device), and the devices signed in, each
 *   of which can be signed out.
 * - **Sessions** (Security, for `security.manage`): how long a session lasts without use and in
 *   all, and every teammate's open sessions, each of which can be ended.
 */
type Session = {
  id: string;
  current: boolean;
  method: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  teammate?: { id: string; name: string };
};
type Account = { email: string | null; passwordChangedAt: string | null; platform: boolean; sessions: Session[] };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
/** "Chrome on macOS", near enough, from a user agent. */
export function device(ua: string | null) {
  if (!ua) return "Unknown browser";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "A browser";
  const os = /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function SignInSettingsPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Account | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ email: "", current: "", password: "", again: "" });
  const load = useCallback(
    () =>
      api<Account>("account")
        .then(setData)
        .catch((e) => setError(message(e, "Your sign-in couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (p: Record<string, unknown>, done: string, fallback: string) => {
    setError("");
    setNotice("");
    try {
      setData(await api<Account>("account", p));
      setNotice(done);
      return true;
    } catch (e) {
      setError(message(e, fallback));
      return false;
    }
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="pg-settings-notice">
          {notice}
        </p>
      )}
      {data && (
        <>
          <Card
            title="Password"
            description={data.email ? `You sign in with ${data.email}. Changing your password signs out every other device.` : "Set a password to sign in to Relay directly, with your email address."}
          >
            <form
              className="pg-signin-settings"
              aria-label={data.email ? "Change password" : "Set up password sign-in"}
              onSubmit={async (e) => {
                e.preventDefault();
                if (form.password !== form.again) return setError("The new passwords don't match.");
                const ok = await act(
                  { action: "password", password: form.password, ...(data.email ? { current: form.current } : { email: form.email }) },
                  data.email ? "Password changed. Your other devices are signed out." : "You can now sign in with your email and password.",
                  "The password couldn't be saved.",
                );
                if (ok) setForm({ email: "", current: "", password: "", again: "" });
              }}
            >
              {data.email ? (
                <label className="pg-settings-field">
                  <span className="pg-settings-label">Current password</span>
                  <input type="password" autoComplete="current-password" required value={form.current} onChange={set("current")} />
                </label>
              ) : (
                <label className="pg-settings-field">
                  <span className="pg-settings-label">Email to sign in with</span>
                  <input type="email" autoComplete="username" required value={form.email} onChange={set("email")} />
                </label>
              )}
              <label className="pg-settings-field">
                <span className="pg-settings-label">New password</span>
                <input type="password" autoComplete="new-password" required minLength={12} aria-describedby="new-password-hint" value={form.password} onChange={set("password")} />
              </label>
              <small id="new-password-hint" className="pg-muted">
                At least 12 characters, not your email address.
              </small>
              <label className="pg-settings-field">
                <span className="pg-settings-label">New password again</span>
                <input type="password" autoComplete="new-password" required value={form.again} onChange={set("again")} />
              </label>
              <button type="submit" className="pg-primary">
                {data.email ? "Change password" : "Set password"}
              </button>
            </form>
          </Card>
          <Card title="Your devices" description="Where you're signed in to Relay. Sign out of any you don't recognise.">
            {data.platform && <p className="pg-muted">You&apos;re signed in here through your hosting account; sign out of it there.</p>}
            {data.sessions.length ? (
              <ul className="pg-settings-list" aria-label="Your devices">
                {data.sessions.map((s) => (
                  <li key={s.id}>
                    <span>
                      <strong>
                        {device(s.userAgent)}
                        {s.current && <span className="pg-settings-badge">This device</span>}
                      </strong>
                      <small className="pg-muted">
                        Signed in {when(s.createdAt)} · last used {when(s.lastSeenAt)}
                        {s.ip ? ` · from ${s.ip}` : ""}
                      </small>
                    </span>
                    {!s.current && (
                      <span className="pg-settings-buttons">
                        <button
                          type="button"
                          aria-label={`Sign out ${device(s.userAgent)}, signed in ${when(s.createdAt)}`}
                          onClick={() => void act({ action: "revoke", sessionId: s.id }, "Signed out of that device.", "That device couldn't be signed out.")}
                        >
                          Sign out
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pg-muted">No devices are signed in with a password.</p>
            )}
            {data.sessions.some((s) => !s.current) && (
              <button
                type="button"
                className="pg-wf-link pg-danger-link"
                onClick={() => void act({ action: "revoke-others" }, "Signed out of every other device.", "Your other devices couldn't be signed out.")}
              >
                Sign out of all other devices
              </button>
            )}
          </Card>
        </>
      )}
    </Frame>
  );
}

type Sessions = { idleMinutes: number; absoluteHours: number; sessions: Session[] };
const IDLE = [
  [60, "1 hour"],
  [480, "8 hours"],
  [1440, "1 day"],
  [5760, "4 days"],
  [10080, "7 days"],
  [43200, "30 days"],
] as const;
const ABSOLUTE = [
  [24, "1 day"],
  [168, "7 days"],
  [720, "30 days"],
  [2160, "90 days"],
] as const;
const options = (list: readonly (readonly [number, string])[], value: number) => (list.some(([v]) => v === value) ? list : [...list, [value, `${value}`] as const]);

export function SessionsPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Sessions | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(
    () =>
      api<Sessions>("security-sessions")
        .then(setData)
        .catch((e) => setError(message(e, "Sessions couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (p: Record<string, unknown>, done: string, fallback: string) => {
    setError("");
    setNotice("");
    try {
      setData(await api<Sessions>("security-sessions", p));
      setNotice(done);
    } catch (e) {
      setError(message(e, fallback));
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
        <p role="status" className="pg-settings-notice">
          {notice}
        </p>
      )}
      {data && (
        <>
          <Card title="Session length" description="Teammates who sign in with a password are signed out after this long without using Relay, and after this long in all, whatever they do.">
            <label className="pg-settings-field">
              <span className="pg-settings-label">Sign out after this long without use</span>
              <select
                value={data.idleMinutes}
                onChange={(e) => void act({ action: "settings", idleMinutes: Number(e.target.value), absoluteHours: data.absoluteHours }, "Session length saved.", "Session length couldn't be saved.")}
              >
                {options(IDLE, data.idleMinutes).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="pg-settings-field">
              <span className="pg-settings-label">Sign out after this long in all</span>
              <select
                value={data.absoluteHours}
                onChange={(e) => void act({ action: "settings", idleMinutes: data.idleMinutes, absoluteHours: Number(e.target.value) }, "Session length saved.", "Session length couldn't be saved.")}
              >
                {options(ABSOLUTE, data.absoluteHours).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </Card>
          <Card title="Signed in now" description="Every teammate's open sessions. Ending one signs that device out at once.">
            {data.sessions.length ? (
              <table className="pg-email-records pg-people-table" aria-label="Open sessions">
                <thead>
                  <tr>
                    <th scope="col">Teammate</th>
                    <th scope="col">Device</th>
                    <th scope="col">Signed in</th>
                    <th scope="col">Last used</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {data.sessions.map((s) => (
                    <tr key={s.id}>
                      <th scope="row">{s.teammate?.name}</th>
                      <td>
                        {device(s.userAgent)}
                        {s.ip && <small className="pg-muted"> · {s.ip}</small>}
                        {s.current && <span className="pg-settings-badge">You, here</span>}
                      </td>
                      <td>{when(s.createdAt)}</td>
                      <td>{when(s.lastSeenAt)}</td>
                      <td>
                        {!s.current && (
                          <button
                            type="button"
                            className="pg-wf-link pg-danger-link"
                            aria-label={`End ${s.teammate?.name}'s session on ${device(s.userAgent)}`}
                            onClick={() => void act({ action: "revoke", sessionId: s.id }, `Signed ${s.teammate?.name} out of that device.`, "That session couldn't be ended.")}
                          >
                            End session
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="pg-muted">No one is signed in with a password.</p>
            )}
          </Card>
        </>
      )}
    </Frame>
  );
}
