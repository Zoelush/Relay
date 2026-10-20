import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";
import { PERMISSIONS } from "./settings-people";

/**
 * Settings › Developers › Apps (phase 15, step D4; docs/DEVELOPER_PLATFORM_STEP4.md), behind
 * `developer_api_v1`, for who manages the workspace: apps registered here (their client id, the
 * secret shown once, redirects and the scopes they may ask for), and apps installed here, each
 * removable at once (its tokens stop working).
 */
type App = { id: string; clientId: string; name: string; description: string; redirectUris: string[]; scopes: string[]; secretLastFour: string; archived: boolean; clientSecret?: string };
type Installed = { id: string; appName: string; scopes: string[]; grantedBy: string; grantedAt: string; lastUsedAt: string | null };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Never");
const LABEL = Object.fromEntries(PERMISSIONS.flatMap(([, items]) => items.map(([cap, label]) => [cap, label])));

export function AppsPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<{ apps: App[]; installed: Installed[] } | null>(null);
  const [error, setError] = useState("");
  const [secret, setSecret] = useState<{ name: string; clientId: string; clientSecret: string } | null>(null);
  const load = useCallback(
    () =>
      api<{ apps: App[]; installed: Installed[] }>("developer-apps")
        .then(setData)
        .catch((e) => setError(message(e, "Apps couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (p: Record<string, unknown>, fallback: string) => {
    setError("");
    try {
      const r = await api<App | { ok: true }>("developer-app", p);
      if ("clientSecret" in r && r.clientSecret) setSecret({ name: r.name, clientId: r.clientId, clientSecret: r.clientSecret });
      await load();
      return r;
    } catch (e) {
      setError(message(e, fallback));
      return null;
    }
  };
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {secret && (
        <Card title={`${secret.name}: its credentials`} description="Copy the secret now: it isn't shown again. Keep it on your server, never in a browser or app.">
          <p>
            Client id <code aria-label="Client id">{secret.clientId}</code>
          </p>
          <p>
            Client secret <code aria-label="Client secret">{secret.clientSecret}</code>
          </p>
          <button type="button" className="pg-wf-link" onClick={() => setSecret(null)}>
            I’ve copied it
          </button>
        </Card>
      )}
      {data && (
        <>
          <Card title="Installed here" description="Apps someone here allowed in. Each acts as the person who allowed it, within the scopes shown. Removing one stops its tokens at once.">
            {data.installed.length ? (
              <table className="pg-email-records pg-people-table" aria-label="Installed apps">
                <thead>
                  <tr>
                    <th scope="col">App</th>
                    <th scope="col">May</th>
                    <th scope="col">Allowed by</th>
                    <th scope="col">Last used</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {data.installed.map((g) => (
                    <tr key={g.id}>
                      <th scope="row">{g.appName}</th>
                      <td>{g.scopes.map((s) => LABEL[s] ?? s).join(", ")}</td>
                      <td>
                        {g.grantedBy} <span className="pg-muted">{when(g.grantedAt)}</span>
                      </td>
                      <td>{when(g.lastUsedAt)}</td>
                      <td>
                        <button type="button" className="pg-wf-link pg-danger-link" onClick={() => void act({ action: "uninstall", id: g.id }, "The app couldn't be removed.")}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="pg-muted">No apps are installed.</p>
            )}
          </Card>
          <Card title="Your apps" description="Apps you build on Relay's API. A workspace installs one through its consent screen (the OAuth 2 authorization code flow, with PKCE).">
            {data.apps.length ? (
              <ul className="pg-webhooks">
                {data.apps.map((a) => (
                  <li key={a.id} aria-label={a.name}>
                    <div className="pg-webhook-head">
                      <span className="pg-email-status" data-status={a.archived ? "failed" : "verified"}>
                        {a.archived ? "Archived" : "Live"}
                      </span>
                      <strong>{a.name}</strong>
                    </div>
                    <p className="pg-muted">
                      Client id <code>{a.clientId}</code> · secret …{a.secretLastFour}
                    </p>
                    <p className="pg-muted">
                      Redirects: {a.redirectUris.join(", ")} · Asks for: {a.scopes.map((s) => LABEL[s] ?? s).join(", ")}
                    </p>
                    {!a.archived && (
                      <div className="pg-webhook-actions">
                        <button type="button" className="pg-wf-link" onClick={() => void act({ action: "secret", id: a.id }, "A new secret couldn't be made.")}>
                          New secret
                        </button>
                        <button type="button" className="pg-wf-link pg-danger-link" onClick={() => void act({ action: "archive", id: a.id }, "The app couldn't be archived.")}>
                          Archive
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pg-muted">No apps yet.</p>
            )}
          </Card>
          <NewApp onCreate={(p) => act({ action: "create", ...p }, "The app couldn't be registered.")} />
        </>
      )}
    </Frame>
  );
}

function NewApp({ onCreate }: { onCreate: (p: Record<string, unknown>) => Promise<unknown> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [redirects, setRedirects] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  return (
    <Card title="Register an app" description="Its name and description are shown on the consent screen. Ask only for what it needs.">
      <label className="pg-settings-field">
        <span className="pg-settings-label">Name</span>
        <input maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="pg-settings-field">
        <span className="pg-settings-label">Description</span>
        <input maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="pg-settings-field">
        <span className="pg-settings-label">Redirect addresses (one per line)</span>
        <textarea rows={2} value={redirects} placeholder="https://example.com/oauth/callback" onChange={(e) => setRedirects(e.target.value)} />
      </label>
      {PERMISSIONS.map(([group, items]) => (
        <fieldset key={group} className="pg-settings-fieldset">
          <legend>{group}</legend>
          {items.map(([cap, label]) => (
            <label key={cap} className="pg-settings-toggle">
              <input type="checkbox" aria-label={cap} checked={scopes.includes(cap)} onChange={(e) => setScopes(e.target.checked ? [...scopes, cap] : scopes.filter((x) => x !== cap))} />
              <span>
                <strong>{label}</strong>
                <small className="pg-muted">
                  <code>{cap}</code>
                </small>
              </span>
            </label>
          ))}
        </fieldset>
      ))}
      <button
        type="button"
        className="pg-primary"
        disabled={!name.trim() || !redirects.trim() || !scopes.length}
        onClick={async () => {
          if (await onCreate({ name, description, redirectUris: redirects.split(/\s+/).filter(Boolean), scopes })) {
            setName("");
            setDescription("");
            setRedirects("");
            setScopes([]);
          }
        }}
      >
        Register app
      </button>
    </Card>
  );
}
