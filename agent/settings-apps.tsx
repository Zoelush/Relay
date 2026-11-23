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
 *
 * T3a (docs/TEST_WORKSPACE_STEP5.md): an app's versions. The fields above are the draft; what
 * anyone installs is a published version, and only the developer's workspace and its test pair
 * install one that isn't released. Each installation here says which version it runs, and a newer
 * one that asks for more waits for a manager's approval, with the new permissions named.
 */
type Version = { version: number; name: string; scopes: string[]; notes: string; publishedAt: string; releasedAt: string | null; installUrl: string | null };
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
  versions: Version[];
  installUrl: string | null;
  listed: boolean;
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
type Running = { running: number | null; waiting: number | null; newScopes: string[]; notes: string; suspended: string | null };
/** T3b: your apps as the directory knows them. */
type Submission = { id: string; version: number; kind: "listing" | "version"; widens: string[]; state: "pending" | "approved" | "rejected" | "withdrawn"; reason: string | null };
type InDirectory = { listing: { version: number; delistedAt: string | null; delistedReason: string | null } | null; submissions: Submission[]; suspended: string | null };
type Data = { apps: App[]; installed: Installed[]; canvas: CanvasOverview; versions: Record<string, Running>; directory: Record<string, InDirectory> };
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
                    const v = data.versions?.[g.id];
                    return (
                      <tr key={g.id}>
                        <th scope="row">
                          {g.appName}
                          {v?.running ? <small className="pg-muted pg-cv-rate">Version {v.running}</small> : null}
                          {v?.suspended ? (
                            <span className="pg-app-suspended" role="alert">
                              Suspended by Relay: {v.suspended}
                            </span>
                          ) : null}
                          {v?.waiting ? (
                            <span className="pg-app-waiting" role="note">
                              Version {v.waiting} also asks to: {v.newScopes.map((s) => LABEL[s] ?? s).join(", ")}
                              {v.notes ? <small className="pg-muted">“{v.notes}”</small> : null}
                              <button type="button" className="pg-primary" onClick={() => void act({ action: "upgrade", id: g.id }, "The new version couldn't be approved.")}>
                                Approve version {v.waiting}
                              </button>
                            </span>
                          ) : null}
                        </th>
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
          <Card
            title="Your apps"
            description="Apps you build on Relay's API. What you edit here is a draft: publish it as a version, try it in this workspace and its test workspace, and release it when other workspaces may install it through the consent screen."
          >
            {data.apps.length ? (
              <ul className="pg-webhooks">
                {data.apps.map((a) => (
                  <li key={a.id} aria-label={a.name}>
                    <div className="pg-webhook-head">
                      <span className="pg-email-status" data-status={a.archived ? "failed" : a.versions.some((v) => v.releasedAt) ? "verified" : "pending"}>
                        {a.archived ? "Archived" : a.versions.some((v) => v.releasedAt) ? "Released" : "In development"}
                      </span>
                      <strong>{a.name}</strong>
                    </div>
                    <Versions app={a} act={act} directory={data.directory?.[a.id]} />
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
  const [installUrl, setInstallUrl] = useState("");
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
      <label className="pg-settings-field">
        <span className="pg-settings-label">Install address (optional)</span>
        <input value={installUrl} placeholder="https://example.com/install" onChange={(e) => setInstallUrl(e.target.value)} />
        <small className="pg-muted">Your page that starts the consent flow. The App directory sends people here when they press Install.</small>
      </label>
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
              ...(installUrl.trim() ? { installUrl } : {}),
            })
          ) {
            setName("");
            setDescription("");
            setRedirects("");
            setScopes([]);
            setCanvasUrl("");
            setPlacements([]);
            setInstallUrl("");
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

/**
 * An app's versions, newest first: each one published from the draft and kept as it was; release
 * one to let other workspaces install it. A version in development installs only here and in this
 * workspace's test pair.
 */
function Versions({ app, act, directory }: { app: App; act: (p: Record<string, unknown>, fallback: string) => Promise<unknown>; directory?: InDirectory }) {
  const [notes, setNotes] = useState("");
  const newestReleased = Math.max(0, ...app.versions.filter((v) => v.releasedAt).map((v) => v.version));
  // T3b: where the app stands in the directory, and the newest decision on each version.
  const decided = (version: number) => directory?.submissions.find((s) => s.version === version);
  const waiting = directory?.submissions.find((s) => s.state === "pending");
  const newest = app.versions.at(-1);
  const listed = directory?.listing && !directory.listing.delistedAt;
  return (
    <div className="pg-app-versions">
      {directory?.suspended ? (
        <p className="pg-app-suspended" role="alert">
          Relay has suspended this app everywhere: {directory.suspended}
        </p>
      ) : listed ? (
        <p className="pg-muted">In the App directory as version {directory!.listing!.version}. A version that asks for more, shows somewhere new or sends people to a new address is reviewed again.</p>
      ) : directory?.listing?.delistedAt ? (
        <p className="pg-app-suspended" role="alert">
          Relay took this app out of the directory: {directory.listing.delistedReason}. Installations keep working.
        </p>
      ) : null}
      {waiting && (
        <div className="pg-app-review" role="status">
          <strong>Version {waiting.version} is waiting for Relay&apos;s review</strong>
          {waiting.widens.map((w) => (
            <small key={w}>{w}</small>
          ))}
        </div>
      )}
      <ol aria-label={`${app.name} versions`}>
        {[...app.versions].reverse().map((v) => (
          <li key={v.version}>
            <strong>Version {v.version}</strong>
            <span className="pg-muted">
              {v.notes || "No notes"} · published {when(v.publishedAt)}
              {decided(v.version)?.state === "rejected" ? <span className="pg-app-rejected"> · Relay asked for changes: {decided(v.version)!.reason}</span> : null}
            </span>
            {v.releasedAt ? (
              <span className="pg-email-status" data-status="verified">
                Released
              </span>
            ) : !app.archived && v.version > newestReleased ? (
              <button type="button" className="pg-wf-link" onClick={() => void act({ action: "release", id: app.id, version: v.version }, "That version couldn't be released.")}>
                Release version {v.version}
              </button>
            ) : (
              <span className="pg-muted">Test workspace only</span>
            )}
          </li>
        ))}
      </ol>
      {!app.archived && !directory?.listing && !waiting && !directory?.suspended && newest && (
        <button
          type="button"
          className="pg-zoe-secondary pg-app-submit"
          disabled={!newest.installUrl}
          title={newest.installUrl ? undefined : "Give the app an install address, then publish, first."}
          onClick={() => void act({ action: "submit", id: app.id, version: newest.version }, "It couldn't be submitted to the directory.")}
        >
          Submit version {newest.version} to the App directory
        </button>
      )}
      {!app.archived && (
        <form
          className="pg-app-publish"
          onSubmit={(e) => {
            e.preventDefault();
            void act({ action: "publish", id: app.id, notes }, "The draft couldn't be published.").then((r) => r && setNotes(""));
          }}
        >
          <input aria-label={`What changed in ${app.name}`} placeholder="What changed (optional)" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
          <button type="submit" className="pg-zoe-secondary">
            Publish the draft as version {(app.versions.at(-1)?.version ?? 0) + 1}
          </button>
        </form>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Settings › Apps › Directory (T3b)                                                               */
/* ---------------------------------------------------------------------------------------------- */
type Listed = {
  name: string;
  description: string;
  developer: string;
  clientId: string;
  version: number;
  scopes: string[];
  placements: Placement[];
  installUrl: string | null;
  installed: boolean;
};
/**
 * Apps Relay has reviewed. Install sends you to the app's own install page, which starts the same
 * consent screen as any app: nothing is installed until someone who manages this workspace allows it.
 */
export function DirectoryPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [apps, setApps] = useState<Listed[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ apps: Listed[] }>("app-directory")
      .then((r) => setApps(r.apps))
      .catch((e) => setError(message(e, "The directory couldn't be loaded.")));
  }, []);
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {apps && !apps.length && (
        <Card title="No apps yet" description="Apps appear here once Relay has reviewed them.">
          <p className="pg-muted">Apps you build yourself are in Settings › Apps, where you can submit one for review.</p>
        </Card>
      )}
      {apps && apps.length > 0 && (
        <ul className="pg-directory" aria-label="App directory">
          {apps.map((a) => (
            <li key={a.clientId} className="pg-directory-card" aria-label={a.name}>
              <header>
                <span className="pg-settings-tile-icon" aria-hidden="true">
                  {a.name.slice(0, 1)}
                </span>
                <span>
                  <strong>{a.name}</strong>
                  <small className="pg-muted">
                    by {a.developer} · version {a.version}
                  </small>
                </span>
              </header>
              <p>{a.description || <span className="pg-muted">No description.</span>}</p>
              <dl>
                <dt>May</dt>
                <dd>{a.scopes.map((s) => LABEL[s] ?? s).join(", ")}</dd>
                <dt>Shows in</dt>
                <dd>{a.placements.filter((p) => p !== "settings").map((p) => PLACEMENT_LABEL[p]).join(", ") || "Nowhere in the inbox"}</dd>
              </dl>
              {a.installed ? (
                <span className="pg-email-status" data-status="verified">
                  Installed
                </span>
              ) : a.installUrl ? (
                <a className="pg-primary" href={a.installUrl}>
                  Install {a.name}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Frame>
  );
}
