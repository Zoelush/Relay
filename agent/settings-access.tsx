import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Security › Access (phase 16, step C3b; docs/SECURITY_STEP4.md), for `security.manage`, behind
 * `security_v1`: require two-factor for password sign-in (only once you have it yourself; it signs
 * out sessions without it), each teammate's two-factor (turned off for one who lost their
 * authenticator), and the two IP allowlists, for the app and for the REST API.
 */
type Access = {
  requireTwoFactor: boolean;
  youHaveTwoFactor: boolean;
  appAllowlist: string[];
  apiAllowlist: string[];
  yourAddress: string | null;
  teammates: { id: string; name: string; email: string; twoFactor: boolean; recoveryCodesLeft: number; you: boolean }[];
};
/** A /32 or /128 is one address: shown without its length. */
const shown = (list: string[]) =>
  list
    .map((e) => e.replace(/\/(32|128)$/, ""))
    .sort()
    .join("\n");

export function AccessPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Access | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lists, setLists] = useState({ app: "", api: "" });
  const take = (d: Access) => {
    setData(d);
    setLists({ app: shown(d.appAllowlist), api: shown(d.apiAllowlist) });
  };
  const load = useCallback(
    () =>
      api<Access>("security-access")
        .then(take)
        .catch((e) => setError(message(e, "Access settings couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (p: Record<string, unknown>, done: string, fallback: string) => {
    setError("");
    setNotice("");
    try {
      take(await api<Access>("security-access", p));
      setNotice(done);
    } catch (e) {
      setError(message(e, fallback));
    }
  };
  const missing = data?.teammates.filter((t) => !t.twoFactor).length ?? 0;
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
          <Card title="Two-factor" description="A code from an authenticator app each time someone signs in with a password, as well as the password.">
            <label className="pg-settings-check">
              <input
                type="checkbox"
                checked={data.requireTwoFactor}
                disabled={!data.requireTwoFactor && !data.youHaveTwoFactor}
                aria-describedby="require-two-factor-hint"
                onChange={(e) =>
                  void act(
                    { action: "require-two-factor", on: e.target.checked },
                    e.target.checked ? "Two-factor is now required." : "Two-factor is no longer required.",
                    "That couldn't be changed.",
                  )
                }
              />
              <span>Require two-factor for everyone who signs in with a password</span>
            </label>
            <small id="require-two-factor-hint" className="pg-muted">
              {!data.youHaveTwoFactor && !data.requireTwoFactor ? (
                <>
                  Turn on two-factor for yourself first, in <a href="#settings/sign-in">Your sign-in</a>.
                </>
              ) : data.requireTwoFactor ? (
                "Teammates without it set it up the next time they sign in, as do new teammates when they accept an invitation."
              ) : (
                `Turning this on signs out ${missing === 1 ? "the 1 teammate" : `the ${missing} teammates`} without two-factor until they set it up.`
              )}
            </small>
            {data.teammates.length ? (
              <table className="pg-email-records pg-people-table" aria-label="Two-factor by teammate">
                <thead>
                  <tr>
                    <th scope="col">Teammate</th>
                    <th scope="col">Signs in as</th>
                    <th scope="col">Two-factor</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {data.teammates.map((t) => (
                    <tr key={t.id}>
                      <th scope="row">
                        {t.name}
                        {t.you && <span className="pg-settings-badge">You</span>}
                      </th>
                      <td>{t.email}</td>
                      <td>{t.twoFactor ? `On · ${t.recoveryCodesLeft} recovery ${t.recoveryCodesLeft === 1 ? "code" : "codes"} left` : "Not set up"}</td>
                      <td>
                        {t.twoFactor && !t.you && (
                          <button
                            type="button"
                            className="pg-wf-link pg-danger-link"
                            aria-label={`Turn off two-factor for ${t.name}`}
                            onClick={() => {
                              if (window.confirm(`Turn off two-factor for ${t.name}? Their sessions end, and they sign in with their password alone${data.requireTwoFactor ? " until they set it up again" : ""}.`))
                                void act({ action: "reset-two-factor", teammateId: t.id }, `Two-factor turned off for ${t.name}.`, "Two-factor couldn't be turned off.");
                            }}
                          >
                            Turn off
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="pg-muted">No one signs in with a password yet.</p>
            )}
            <p className="pg-muted">Turn off a teammate’s two-factor only when they’ve lost their authenticator and their recovery codes, and you’re sure it’s them.</p>
          </Card>
          <Card
            title="IP allowlists"
            description="Addresses or ranges (like 203.0.113.0/24), one per line, up to 100 each. Leave a list empty to allow anywhere. The app's list covers the inbox, Settings and signing in, however a teammate signs in."
          >
            <form
              className="pg-signin-settings pg-allowlists"
              aria-label="IP allowlists"
              onSubmit={(e) => {
                e.preventDefault();
                void act({ action: "allowlists", app: lists.app, api: lists.api }, "Allowlists saved.", "The allowlists couldn't be saved.");
              }}
            >
              <p className="pg-muted">{data.yourAddress ? `Your address: ${data.yourAddress}` : "Relay can't see your address from here."}</p>
              <label className="pg-settings-field">
                <span className="pg-settings-label">The app</span>
                <textarea rows={4} spellCheck={false} value={lists.app} placeholder="Anywhere" onChange={(e) => setLists({ ...lists, app: e.target.value })} />
              </label>
              <label className="pg-settings-field">
                <span className="pg-settings-label">The REST API</span>
                <textarea rows={4} spellCheck={false} value={lists.api} placeholder="Anywhere" onChange={(e) => setLists({ ...lists, api: e.target.value })} />
              </label>
              <button type="submit" className="pg-primary">
                Save allowlists
              </button>
            </form>
          </Card>
        </>
      )}
    </Frame>
  );
}
