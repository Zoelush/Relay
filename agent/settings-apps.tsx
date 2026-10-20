import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";
import { PERMISSIONS } from "./settings-people";
import { CanvasApp } from "./canvas";
import { PLACEMENTS, PLACEMENT_LABEL, type Placement } from "../lib/canvas";

/**
 * Settings › Developers › Apps (phase 15, step D4; docs/DEVELOPER_PLATFORM_STEP4.md), behind
 * `developer_api_v1`, for who manages the workspace: apps registered here (their client id, the
 * secret shown once, redirects and the scopes they may ask for), and apps installed here, each
 * removable at once (its tokens stop working).
 *
 * D5 adds Canvas: an app's canvas address, placements and signing secret (shown once), its error
 * rate across the workspaces that installed it; and for each app installed here, where it shows,
 * its error rate here, and its configure step (drawn from the app, in settings).
 */
type App = {
  id: string;
  clientId: string;
  name: string;
  description: string;
  redirectUris: string[];
  scopes: string[];
  secretLastFour: string;
  archived: boolean;
  clientSecret?: string;
  canvasUrl: string | null;
  canvasPlacements: Placement[];
  canvasSecretLastFour: string | null;
  canvasSecret?: string;
};
type Installed = {
  id: string;
  appName: string;
  scopes: string[];
  grantedBy: string;
  grantedAt: string;
  lastUsedAt: string | null;
};
type Rate = { calls: number; failures: number };
type CanvasOverview = {
  installed: Record<string, { placements: Placement[]; configured: boolean } & Rate>;
  apps: Record<string, Rate & { timeouts: number }>;
  days: number;
};
type Data = { apps: App[]; installed: Installed[]; canvas: CanvasOverview };
type Shown = {
  name: string;
  clientId: string;
  clientSecret?: string;
  canvasSecret?: string;
};
/** "120 requests · 3 failed (2.5%)", or that there were none. */
const rate = (r: Rate | undefined, days: number) =>
  !r || !r.calls
    ? `No requests in ${days} days`
    : `${r.calls} request${r.calls === 1 ? "" : "s"} in ${days} days · ${r.failures} failed (${((r.failures / r.calls) * 100).toFixed(1).replace(/\.0$/, "")}%)`;
const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Never";
const LABEL = Object.fromEntries(PERMISSIONS.flatMap(([, items]) => items.map(([cap, label]) => [cap, label])));

export function AppsPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [secret, setSecret] = useState<Shown | null>(null);
  const [configuring, setConfiguring] = useState<Installed | null>(null);
  const load = useCallback(
    () =>
      api<Data>("developer-apps")
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
      if ("clientId" in r && (r.clientSecret || r.canvasSecret))
        setSecret({
          name: r.name,
          clientId: r.clientId,
          clientSecret: r.clientSecret,
          canvasSecret: r.canvasSecret,
        });
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
        <Card title={`${secret.name}: its credentials`} description="Copy the secrets now: they aren't shown again. Keep them on your server, never in a browser or app.">
          <p>
            Client id <code aria-label="Client id">{secret.clientId}</code>
          </p>
          {secret.clientSecret && (
            <p>
              Client secret <code aria-label="Client secret">{secret.clientSecret}</code>
            </p>
          )}
          {secret.canvasSecret && (
            <p>
              Canvas signing secret <code aria-label="Canvas signing secret">{secret.canvasSecret}</code>
              <small className="pg-muted"> Verify each canvas request&apos;s Relay-Signature with it, as for webhooks.</small>
            </p>
          )}
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
                    <th scope="col">Shows in</th>
                    <th scope="col">Allowed by</th>
                    <th scope="col">Last used</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {data.installed.map((g) => {
                    const cv = data.canvas.installed[g.id];
                    const configurable = !!cv?.placements.includes("settings");
                    return (
                      <tr key={g.id}>
                        <th scope="row">{g.appName}</th>
                        <td>{g.scopes.map((s) => LABEL[s] ?? s).join(", ")}</td>
                        <td>
                          {cv?.placements.filter((p) => p !== "settings").length ? (
                            cv.placements
                              .filter((p) => p !== "settings")
                              .map((p) => PLACEMENT_LABEL[p])
                              .join(", ")
                          ) : (
                            <span className="pg-muted">Nowhere</span>
                          )}
                          {cv?.placements.length ? <small className="pg-muted pg-cv-rate">{rate(cv, data.canvas.days)}</small> : null}
                          {configurable && !cv.configured && <small className="pg-cv-needs">Needs setting up</small>}
                        </td>
                        <td>
                          {g.grantedBy} <span className="pg-muted">{when(g.grantedAt)}</span>
                        </td>
                        <td>{when(g.lastUsedAt)}</td>
                        <td>
                          {configurable && (
                            <button type="button" className="pg-wf-link" onClick={() => setConfiguring(g)}>
                              Configure
                            </button>
                          )}
                          <button type="button" className="pg-wf-link pg-danger-link" onClick={() => void act({ action: "uninstall", id: g.id }, "The app couldn't be removed.")}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="pg-muted">No apps are installed.</p>
            )}
          </Card>
          {configuring && (
            <Card title={`Set up ${configuring.appName}`} description="This is drawn by the app. What you choose is kept with this installation and sent to the app with every request.">
              <div className="pg-cv-settings">
                <CanvasApp
                  key={configuring.id}
                  app={{
                    installationId: configuring.id,
                    appName: configuring.appName,
                    placement: "settings",
                  }}
                  onConfigured={() => void load()}
                />
              </div>
              <button type="button" className="pg-wf-link" onClick={() => setConfiguring(null)}>
                Close
              </button>
            </Card>
          )}
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
                    <p className="pg-muted">
                      {a.canvasUrl ? (
                        <>
                          Canvas <code>{a.canvasUrl}</code> · {a.canvasPlacements.length ? a.canvasPlacements.map((p) => PLACEMENT_LABEL[p]).join(", ") : "no placements"} · signing secret …
                          {a.canvasSecretLastFour}
                          <br />
                          <span aria-label={`${a.name} canvas requests`}>{rate(data.canvas.apps[a.id], data.canvas.days)}, across every workspace that installed it</span>
                        </>
                      ) : (
                        "No canvas: it doesn't draw in Relay."
                      )}
                    </p>
                    {!a.archived && (
                      <div className="pg-webhook-actions">
                        <button type="button" className="pg-wf-link" onClick={() => void act({ action: "secret", id: a.id }, "A new secret couldn't be made.")}>
                          New secret
                        </button>
                        <CanvasSettings app={a} onSave={(p) => act({ action: "update", id: a.id, ...p }, "The canvas couldn't be saved.")} />
                        {a.canvasUrl && (
                          <button type="button" className="pg-wf-link" onClick={() => void act({ action: "canvas-secret", id: a.id }, "A new signing secret couldn't be made.")}>
                            New signing secret
                          </button>
                        )}
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
  const [canvasUrl, setCanvasUrl] = useState("");
  const [placements, setPlacements] = useState<Placement[]>([]);
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
      <CanvasFields url={canvasUrl} placements={placements} onUrl={setCanvasUrl} onPlacements={setPlacements} />
      <button
        type="button"
        className="pg-primary"
        disabled={!name.trim() || !redirects.trim() || !scopes.length}
        onClick={async () => {
          if (
            await onCreate({
              name,
              description,
              redirectUris: redirects.split(/\s+/).filter(Boolean),
              scopes,
              ...(canvasUrl.trim() ? { canvasUrl, canvasPlacements: placements } : {}),
            })
          ) {
            setName("");
            setDescription("");
            setRedirects("");
            setScopes([]);
            setCanvasUrl("");
            setPlacements([]);
          }
        }}
      >
        Register app
      </button>
    </Card>
  );
}

/** An app's canvas: the address Relay sends its requests to, and where it draws. */
function CanvasFields({ url, placements, onUrl, onPlacements }: { url: string; placements: Placement[]; onUrl: (v: string) => void; onPlacements: (v: Placement[]) => void }) {
  return (
    <fieldset className="pg-settings-fieldset">
      <legend>Canvas (optional)</legend>
      <label className="pg-settings-field">
        <span className="pg-settings-label">Canvas address</span>
        <input value={url} placeholder="https://example.com/canvas" onChange={(e) => onUrl(e.target.value)} />
        <small className="pg-muted">Relay POSTs /initialize, /submit and /configure under it, signed, and draws what comes back.</small>
      </label>
      {PLACEMENTS.map((p) => (
        <label key={p} className="pg-settings-toggle">
          <input type="checkbox" checked={placements.includes(p)} onChange={(e) => onPlacements(e.target.checked ? [...placements, p] : placements.filter((x) => x !== p))} />
          <span>
            <strong>{PLACEMENT_LABEL[p]}</strong>
            <small className="pg-muted">
              <code>{p}</code>
            </small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Changing an app's canvas, in place. */
function CanvasSettings({ app, onSave }: { app: App; onSave: (p: Record<string, unknown>) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(app.canvasUrl ?? "");
  const [placements, setPlacements] = useState<Placement[]>(app.canvasPlacements);
  if (!open)
    return (
      <button type="button" className="pg-wf-link" onClick={() => setOpen(true)}>
        Canvas…
      </button>
    );
  return (
    <div className="pg-cv-edit" role="group" aria-label={`${app.name} canvas`}>
      <CanvasFields url={url} placements={placements} onUrl={setUrl} onPlacements={setPlacements} />
      <button
        type="button"
        className="pg-primary"
        onClick={async () => {
          if (await onSave({ canvasUrl: url, canvasPlacements: placements })) setOpen(false);
        }}
      >
        Save canvas
      </button>
      <button type="button" className="pg-wf-link" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}
