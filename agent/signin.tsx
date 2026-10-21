import { useEffect, useState } from "react";
import { KeyRound, UserPlus } from "lucide-react";
import "./inbox.css";
import { applyTheme, readChoice } from "./theme";

/**
 * Relay's own sign-in (phase 16, step C3a; docs/SECURITY_STEP3.md): `/signin` (email and password)
 * and `/invite` (accepting an invitation: your name and a password). Both post to the host's
 * `/auth/*`, which keeps the session in an HttpOnly cookie, then go to the inbox (or `?next=`).
 * The invitation's token is read from after the `#`, so it never reaches a server's logs.
 */
type Problem = { error?: { code?: string; message?: string } };
async function post<T>(path: string, body: unknown): Promise<T & Problem & { ok: boolean }> {
  const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await r.json().catch(() => ({}))) as T & Problem;
  return { ...data, ok: r.ok };
}
/** Only a path on this host: never an address somewhere else. */
const nextPath = () => {
  const next = new URLSearchParams(window.location.search).get("next") ?? "";
  return /^\/(?!\/)[\w\-./#?=&%]*$/.test(next) ? next : "/agent";
};
const useTheme = () =>
  useEffect(() => {
    applyTheme(readChoice(() => localStorage));
  }, []);

export function SignIn() {
  useTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="pg-consent">
      <section className="pg-consent-card" aria-label="Sign in">
        <span className="pg-consent-icon" aria-hidden="true">
          <KeyRound size={22} />
        </span>
        <h1>Sign in to Relay</h1>
        <form
          className="pg-signin-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const r = await post("/auth/signin", { email, password });
            if (r.ok) window.location.assign(nextPath());
            else {
              setError(r.error?.message ?? "Sign-in is unavailable. Try again.");
              setBusy(false);
            }
          }}
        >
          <label>
            <span>Email</span>
            <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            <span>Password</span>
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && (
            <p role="alert" className="pg-attr-error">
              {error}
            </p>
          )}
          <button type="submit" className="pg-primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="pg-muted">Forgot your password? Ask someone who manages your teammates to send you a password reset.</p>
      </section>
    </main>
  );
}

type Invitation = { email: string; name: string; role: string; invitedBy: string | null; workspace: string; expiresAt: string; reset: boolean };
export function AcceptInvitation() {
  useTheme();
  const token = window.location.hash.slice(1);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [problem, setProblem] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void post<Invitation>("/auth/invitation", { token }).then((r) => {
      if (r.ok) {
        setInvitation(r);
        setName(r.name);
      } else setProblem(r.error?.message ?? "This invitation can't be read.");
    });
  }, [token]);
  return (
    <main className="pg-consent">
      <section className="pg-consent-card" aria-label="Join a workspace">
        <span className="pg-consent-icon" aria-hidden="true">
          <UserPlus size={22} />
        </span>
        {problem ? (
          <>
            <h1>This invitation can’t be used</h1>
            <p role="alert" className="pg-attr-error">
              {problem}
            </p>
            <p>
              <a href="/signin">Sign in</a>
            </p>
          </>
        ) : !invitation ? (
          <p className="pg-muted">Reading your invitation…</p>
        ) : (
          <>
            <h1>{invitation.reset ? "Choose a new password" : `Join ${invitation.workspace}`}</h1>
            <p className="pg-muted">
              {invitation.reset ? (
                <>
                  {invitation.invitedBy ?? "A teammate"} sent a password reset for <strong>{invitation.email}</strong>. Your other sessions end when you save it.
                </>
              ) : (
                <>
                  {invitation.invitedBy ?? "A teammate"} invited <strong>{invitation.email}</strong> as {invitation.role}. Choose your name and a password to sign in with.
                </>
              )}
            </p>
            <form
              className="pg-signin-form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (password !== again) return setError("The passwords don't match.");
                setBusy(true);
                setError("");
                const r = await post("/auth/accept", { token, name, password });
                if (r.ok) window.location.assign("/agent");
                else {
                  setError(r.error?.message ?? "That didn't work. Try again.");
                  setBusy(false);
                }
              }}
            >
              {!invitation.reset && (
                <label>
                  <span>Your name</span>
                  <input autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
                </label>
              )}
              <label>
                <span>Password</span>
                <input type="password" autoComplete="new-password" required minLength={12} aria-describedby="invite-password-hint" value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
              <small id="invite-password-hint" className="pg-muted">
                At least 12 characters, not your email address.
              </small>
              <label>
                <span>Password again</span>
                <input type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
              </label>
              {error && (
                <p role="alert" className="pg-attr-error">
                  {error}
                </p>
              )}
              <button type="submit" className="pg-primary" disabled={busy}>
                {busy ? "Saving…" : invitation.reset ? "Save and sign in" : "Join and sign in"}
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
