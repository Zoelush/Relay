import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "./api";
import { message } from "./settings-ui";
import { PERMISSIONS } from "./settings-people";
import "./inbox.css";
import { applyTheme, readChoice } from "./theme";

/**
 * The consent screen (phase 15, step D4; docs/DEVELOPER_PLATFORM_STEP4.md), at `/oauth/authorize`:
 * an app asks to be installed. It shows exactly what's asked, in the words Roles uses; what the
 * teammate doesn't have themselves can't be granted, and says so. Allow sends them back to the app
 * with a code; Cancel sends `error=access_denied`. A problem with the request (an unknown app, an
 * unregistered redirect) is shown here and never sent anywhere.
 */
type Consent = { app: { name: string; description: string; developer: string }; workspace: string; scopes: { id: string; granted: boolean }[]; redirectUri: string };
const LABELS = Object.fromEntries(PERMISSIONS.flatMap(([, items]) => items.map(([cap, label, help]) => [cap, { label, help }])));

export default function OAuthConsent() {
  const query = Object.fromEntries(new URLSearchParams(window.location.search));
  const [consent, setConsent] = useState<Consent | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    applyTheme(readChoice(() => localStorage));
    api<Consent>("oauth-consent?" + new URLSearchParams(query).toString())
      .then(setConsent)
      .catch((e) => setError(message(e, "This request couldn't be read.")));
    // The query is fixed for this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const decide = async (decision: "approve" | "deny") => {
    setBusy(true);
    try {
      const r = await api<{ redirect: string }>("oauth-consent", { ...query, decision });
      window.location.assign(r.redirect);
    } catch (e) {
      setError(message(e, "That didn't work."));
      setBusy(false);
    }
  };
  return (
    <main className="pg-consent">
      <section className="pg-consent-card" aria-label="Install an app">
        <span className="pg-consent-icon" aria-hidden="true">
          <ShieldCheck size={22} />
        </span>
        {error ? (
          <>
            <h1>This app can’t be connected</h1>
            <p role="alert" className="pg-attr-error">
              {error}
            </p>
          </>
        ) : !consent ? (
          <p className="pg-muted">Reading the request…</p>
        ) : (
          <>
            <h1>
              {consent.app.name} wants to connect to {consent.workspace}
            </h1>
            <p className="pg-muted">
              Made by {consent.app.developer}. {consent.app.description}
            </p>
            <h2>It will be able to act as you, to:</h2>
            <ul className="pg-consent-scopes">
              {consent.scopes.map((s) => (
                <li key={s.id} data-granted={s.granted ? "true" : "false"}>
                  <strong>{LABELS[s.id]?.label ?? s.id}</strong>
                  <small className="pg-muted">
                    <code>{s.id}</code>
                    {!s.granted && " · not granted: you don’t have this permission yourself"}
                  </small>
                </li>
              ))}
            </ul>
            <p className="pg-muted">You can remove it any time in Settings › Developers › Apps. It will be sent back to {new URL(consent.redirectUri).host}.</p>
            <div className="pg-consent-actions">
              <button type="button" className="pg-primary" disabled={busy || !consent.scopes.some((s) => s.granted)} onClick={() => void decide("approve")}>
                Allow
              </button>
              <button type="button" className="pg-secondary" disabled={busy} onClick={() => void decide("deny")}>
                Cancel
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
