import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › Security › Retention (phase 16, step C6a; docs/SECURITY_STEP9.md), for
 * `security.manage`, behind `security_v1`: how long each kind of data is kept (keep, or 30 days to
 * 7 years), what a change would delete before it's saved, and the last run's counts. Relay applies
 * the policies about hourly; "Run now" applies them at once.
 */
type Kind = "conversations" | "attachments" | "recordings" | "events" | "logs";
type Retention = {
  kinds: { kind: Kind; label: string; covers: string }[];
  periods: number[];
  policies: Record<Kind, number | null>;
  lastRunAt: string | null;
  lastResult: Record<string, number> | null;
};
type Preview = Partial<Record<Kind, number>>;
const period = (d: number) => (d % 365 === 0 ? `${d / 365} year${d === 365 ? "" : "s"}` : d === 2557 ? "7 years" : d === 180 ? "6 months" : `${d} days`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function RetentionPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Retention | null>(null);
  const [draft, setDraft] = useState<Record<Kind, number | null> | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const take = (d: Retention) => {
    setData(d);
    setDraft(d.policies);
    setPreview(null);
  };
  const load = useCallback(
    () =>
      api<Retention>("retention")
        .then(take)
        .catch((e) => setError(message(e, "Retention couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const changed = !!data && !!draft && data.kinds.some(({ kind }) => data.policies[kind] !== draft[kind]);
  // What the new periods would delete on the next run, before they're saved.
  useEffect(() => {
    if (!changed || !draft) return;
    let live = true;
    api<{ wouldDelete: Preview }>("retention", { action: "preview", policies: draft })
      .then((r) => live && setPreview(r.wouldDelete))
      .catch(() => live && setPreview(null));
    return () => {
      live = false;
    };
  }, [changed, draft]);
  const act = async (p: Record<string, unknown>, done: string, fallback: string) => {
    setError("");
    setNotice("");
    try {
      take(await api<Retention>("retention", p));
      setNotice(done);
    } catch (e) {
      setError(message(e, fallback));
    }
  };
  const warning =
    preview && changed
      ? (["conversations", "attachments", "recordings", "events"] as const)
          .filter((k) => (preview[k] ?? 0) > 0)
          .map((k) => `${data!.kinds.find((x) => x.kind === k)!.label}: ${preview[k]! > 10000 ? "over 10,000" : preview[k]!.toLocaleString()}`)
      : [];
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
      {data && draft && (
        <>
          <Card title="How long Relay keeps data" description="Data older than its period is deleted permanently, about once an hour. Keep means it's never deleted by age. A customer's whole record is deleted only by a data request.">
            <form
              className="pg-signin-settings"
              aria-label="Retention policies"
              onSubmit={(e) => {
                e.preventDefault();
                void act({ action: "policies", policies: draft }, "Retention saved.", "Retention couldn't be saved.");
              }}
            >
              {data.kinds.map(({ kind, label, covers }) => (
                <label key={kind} className="pg-settings-field">
                  <span className="pg-settings-label">{label}</span>
                  <select value={draft[kind] ?? "keep"} aria-describedby={`retention-${kind}`} onChange={(e) => setDraft({ ...draft, [kind]: e.target.value === "keep" ? null : Number(e.target.value) })}>
                    <option value="keep">Keep</option>
                    {data.periods.map((d) => (
                      <option key={d} value={d}>
                        {period(d)}
                      </option>
                    ))}
                  </select>
                  <small id={`retention-${kind}`} className="pg-muted">
                    {covers}
                  </small>
                </label>
              ))}
              {warning.length > 0 && (
                <p role="alert" className="pg-retention-warning">
                  Saving this deletes, on the next run: {warning.join("; ")}. This can’t be undone.
                </p>
              )}
              <span className="pg-settings-buttons">
                <button type="submit" className="pg-primary" disabled={!changed}>
                  Save retention
                </button>
              </span>
            </form>
          </Card>
          <Card title="Last run" description="Each run is also in the audit log, with what it deleted.">
            {data.lastRunAt ? (
              <>
                <p>{when(data.lastRunAt)}</p>
                {data.lastResult && Object.keys(data.lastResult).length ? (
                  <ul className="pg-settings-list" aria-label="Deleted in the last run">
                    {Object.entries(data.lastResult).map(([what, n]) => (
                      <li key={what}>
                        <span>
                          {what.charAt(0).toUpperCase() + what.slice(1)}: {n.toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="pg-muted">Nothing was old enough to delete.</p>
                )}
              </>
            ) : (
              <p className="pg-muted">Not run yet.</p>
            )}
            <button type="button" className="pg-secondary" onClick={() => void act({ action: "run" }, "Running now. Refresh in a moment to see what it deleted.", "It couldn't be run.")}>
              Run now
            </button>
          </Card>
        </>
      )}
    </Frame>
  );
}
