import { useMemo, useState, type ReactNode } from "react";
import qrcode from "qrcode-generator";

/**
 * Two-factor pieces shared by sign-in and Your sign-in (phase 16, step C3b; docs/SECURITY_STEP4.md):
 * the QR code an authenticator app scans (drawn here from the `otpauth://` address, dark on light in
 * both themes, with the key as text beside it), a field for the code, and the recovery codes, shown once.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { size: n + 8, path: d };
  }, [value]);
  return (
    <svg className="pg-qr" role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges">
      <rect width={size} height={size} className="pg-qr-paper" />
      <path d={path} className="pg-qr-ink" />
    </svg>
  );
}

/** The key in groups of four, as an authenticator app's "enter a key" shows it. */
export const spacedKey = (secret: string) => secret.replace(/(.{4})/g, "$1 ").trim();

/** Scan, or type the key; then the first code. */
export function SetupSteps({ setup, children }: { setup: { secret: string; uri: string }; children: ReactNode }) {
  return (
    <div className="pg-2fa-setup">
      <QrCode value={setup.uri} label="QR code for your authenticator app" />
      <div className="pg-2fa-steps">
        <ol>
          <li>Open an authenticator app (such as 1Password, Google Authenticator or Microsoft Authenticator) and scan the code.</li>
          <li>
            Can’t scan it? Enter this key instead:
            <code className="pg-2fa-key" aria-label="Setup key">
              {spacedKey(setup.secret)}
            </code>
          </li>
          <li>Type the six-digit code the app shows.</li>
        </ol>
        {children}
      </div>
    </div>
  );
}

/** A code from the app; or a recovery code; or `either`. */
export function CodeField({ value, onChange, recovery, either, label }: { value: string; onChange: (v: string) => void; recovery?: boolean; either?: boolean; label?: string }) {
  const text = recovery || either;
  return (
    <label>
      <span>{label ?? (either ? "Code from your app, or a recovery code" : recovery ? "Recovery code" : "Code from your app")}</span>
      <input
        required
        autoComplete="one-time-code"
        inputMode={text ? "text" : "numeric"}
        pattern={either ? "[A-Za-z0-9 -]{6,13}" : recovery ? "[A-Za-z0-9 -]{10,13}" : "[0-9 ]{6,7}"}
        maxLength={text ? 13 : 7}
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** Shown once: each works one time, if the authenticator is lost. */
export function RecoveryCodes({ codes, onDone, doneLabel }: { codes: string[]; onDone: () => void; doneLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="pg-2fa-codes">
      <p>
        Save these recovery codes somewhere safe, such as a password manager. Each signs you in once if you lose your authenticator. <strong>They won’t be shown again.</strong>
      </p>
      <ul aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ul>
      <div className="pg-settings-buttons">
        <button
          type="button"
          className="pg-secondary"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(codes.join("\n"))
              .then(() => setCopied(true))
              .catch(() => undefined)
          }
        >
          {copied ? "Copied" : "Copy codes"}
        </button>
        <button type="button" className="pg-primary" onClick={onDone}>
          {doneLabel}
        </button>
      </div>
    </div>
  );
}
