import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";
import { PERMISSIONS } from "./settings-people";

/**
 * Settings › Developers › API tokens (phase 15, step D1; docs/DEVELOPER_PLATFORM_PLAN.md), behind
 * `developer_api_v1`: make a personal access token (shown once), see each token's scopes, last use
 * and the last hour's calls, and revoke it. Scopes offered are the teammate's own capabilities.
 */
type Token = {
  id: string;
  name: string;
  owner: { id: string; name: string };
  lastFour: string;
  scopes: string[];
  version: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  lastHour: { calls: number; limited: number };
};
type Settings = { apiBase: string; versions: string[]; latest: string; limits: { perMinute: number; burst: number; workspacePerMinute: number }; scopes: string[]; manager: boolean; me: string; tokens: Token[] };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Never");

export function DevelopersPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [made, setMade] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api<Settings>("developer-settings")
        .then(setData)
        .catch((e) => setError(message(e, "Developer settings couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const create = async () => {
    setError("");
    try {
      const r = await api<{ token: string }>("developer-token", { action: "create", name, scopes });
      setMade(r.token);
      setName("");
      setScopes([]);
      void load();
    } catch (e) {
      setError(message(e, "The token couldn't be made."));
    }
  };
  const revoke = async (id: string) => {
    try {
      await api("developer-token", { action: "revoke", id });
      void load();
    } catch (e) {
      setError(message(e, "The token couldn't be revoked."));
    }
  };
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {data && (
        <>
          <Card title="Relay's API" description={`Base URL ${data.apiBase}. Each token may burst to ${data.limits.burst} requests and make ${data.limits.perMinute} a minute; the workspace, ${data.limits.workspacePerMinute} a minute.`}>
            <p>
              <a href="/developers" target="_blank" rel="noreferrer">
                The API reference
              </a>{" "}
              · current version <code>{data.latest}</code>
            </p>
          </Card>
          <Card title="New token" description="A token acts as you, within the scopes you choose. You'll see it once: copy it somewhere safe.">
            {made && (
              <p className="pg-settings-row" aria-label="Your new token">
                <code>{made}</code>
              </p>
            )}
            <label className="pg-settings-field">
              <span className="pg-settings-label">Name</span>
              <input maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            {/* Scopes are permissions, named as on Roles: only those your own role has. */}
            {PERMISSIONS.map(([group, items]) => {
              const mine = items.filter(([cap]) => data.scopes.includes(cap));
              if (!mine.length) return null;
              return (
                <fieldset key={group} className="pg-settings-fieldset">
                  <legend>{group}</legend>
                  {mine.map(([cap, label]) => (
                    <label key={cap} className="pg-settings-toggle">
                      <input
                        type="checkbox"
                        aria-label={cap}
                        checked={scopes.includes(cap)}
                        onChange={(e) => setScopes(e.target.checked ? [...scopes, cap] : scopes.filter((x) => x !== cap))}
                      />
                      <span>
                        <strong>{label}</strong>
                        <small className="pg-muted">
                          <code>{cap}</code>
                        </small>
                      </span>
                    </label>
                  ))}
                </fieldset>
              );
            })}
            <button type="button" className="pg-primary" disabled={!name.trim() || !scopes.length} onClick={() => void create()}>
              Make token
            </button>
          </Card>
          <Card title="Tokens" description={data.manager ? "Everyone's tokens in this workspace." : "Your tokens."}>
            <table className="pg-email-records pg-people-table" aria-label="Tokens">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Scopes</th>
                  <th scope="col">Last used</th>
                  <th scope="col">Last hour</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {data.tokens.map((t) => (
                  <tr key={t.id}>
                    <th scope="row">
                      {t.name} <span className="pg-muted">…{t.lastFour}</span>
                    </th>
                    <td>{t.owner.name}</td>
                    <td>{t.scopes.join(", ")}</td>
                    <td>{when(t.lastUsedAt)}</td>
                    <td>
                      {t.lastHour.calls} calls{t.lastHour.limited ? `, ${t.lastHour.limited} refused` : ""}
                    </td>
                    <td>
                      {t.revokedAt ? (
                        <span className="pg-muted">Revoked</span>
                      ) : (
                        <button type="button" className="pg-wf-link" onClick={() => void revoke(t.id)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </Frame>
  );
}
