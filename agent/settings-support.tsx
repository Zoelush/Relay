import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › Security › Support access (phase 16, step C7b; docs/SECURITY_STEP12.md), for
 * `security.manage`, behind `security_v1`: read-only access for Relay's support staff, granted for
 * 1, 7 or 14 days and revocable at any time, with every grant and staff session kept as history.
 */
type Grant = {
  id: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string;
  endedAt: string | null;
  revokedBy: string | null;
  sessions: { email: string; startedAt: string; endedAt: string | null }[];
};
type Support = { configured: boolean; days: number[]; active: Grant | null; history: Grant[] };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function SupportAccessPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Support | null>(null);
  const [days, setDays] = useState(7);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(
    () =>
      api<Support>("support-access")
        .then(setData)
        .catch((e) => setError(message(e, "Support access couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (p: Record<string, unknown>, done: string, fallback: string) => {
    setError("");
    setNotice("");
    try {
      setData(await api<Support>("support-access", p));
      setNotice(done);
    } catch (e) {
      setError(message(e, fallback));
    }
  };
  const active = data?.active;
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
            title="Relay support"
            description="Let Relay's support team look at this workspace to help you. They can see everything an owner can, but can't change, send or delete anything. Every page they open is in the audit log."
          >
            {!data.configured && <p className="pg-muted">Support sign-in isn&apos;t set up for this deployment, so no one from Relay can use a grant yet.</p>}
            {active ? (
              <>
                <p aria-label="Current access">
                  <strong>Access is on</strong> until {when(active.expiresAt)}, granted by {active.grantedBy}.
                </p>
                <span className="pg-settings-buttons">
                  <button
                    type="button"
                    className="pg-primary pg-danger"
                    onClick={() => void act({ action: "revoke" }, "Relay support's access was revoked, and anyone signed in was signed out.", "It couldn't be revoked.")}
                  >
                    Revoke access
                  </button>
                </span>
              </>
            ) : (
              <form
                className="pg-signin-settings"
                aria-label="Grant support access"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act({ action: "grant", days }, `Relay support has read-only access for ${days === 1 ? "1 day" : `${days} days`}.`, "Access couldn't be granted.");
                }}
              >
                <p className="pg-muted">Access is off.</p>
                <label className="pg-settings-field">
                  <span className="pg-settings-label">For</span>
                  <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                    {data.days.map((d) => (
                      <option key={d} value={d}>
                        {d === 1 ? "1 day" : `${d} days`}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="pg-settings-buttons">
                  <button type="submit" className="pg-primary">
                    Grant access
                  </button>
                </span>
              </form>
            )}
          </Card>
          <Card title="History" description="Each grant, and who from Relay signed in under it.">
            {data.history.length ? (
              <ul className="pg-settings-list" aria-label="Support access history">
                {data.history.map((g) => (
                  <li key={g.id}>
                    <span>
                      {when(g.grantedAt)} by {g.grantedBy}:{" "}
                      {g.endedAt ? (g.revokedBy ? `revoked by ${g.revokedBy} on ${when(g.endedAt)}` : `ended ${when(g.endedAt)}`) : `until ${when(g.expiresAt)}`}
                      {g.sessions.length > 0 && (
                        <small className="pg-muted">
                          {" "}
                          · Signed in: {g.sessions.map((s) => `${s.email} (${when(s.startedAt)})`).join(", ")}
                        </small>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pg-muted">Relay support has never had access.</p>
            )}
          </Card>
        </>
      )}
    </Frame>
  );
}
