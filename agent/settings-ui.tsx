import { useEffect, useState, type ReactNode } from "react";
import { Save, type LucideIcon } from "lucide-react";
import { api } from "./api";
import { ShowMenuButton, type SideMenuState } from "./shell";

/**
 * The building blocks of a Settings page (agent/settings.tsx; docs/SETTINGS_STEP1.md): the frame
 * with its title, purpose and Save button, explained cards and fields, and form state that knows
 * when something changed.
 */
export type Page = {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  group: string;
  /** Opens where the feature already lives, instead of a page here. */
  link?: boolean;
};

export const message = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;
/**
 * The timezones to choose from: this browser's list, with UTC first and the saved value always
 * present (some browsers leave UTC out, and a select can't show a value it lacks).
 */
export const timezones = (current?: string | null): string[] => {
  const all =
    (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.("timeZone") ?? [];
  const list = ["UTC", ...all.filter((z) => z !== "UTC")];
  return current && !list.includes(current) ? [current, ...list] : list;
};
export const deviceZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;

export type MenuState = SideMenuState;

/** A settings page: its title and purpose, a Save button when it has one, and its cards. */
export function Frame({
  menu,
  page,
  save,
  children,
}: {
  menu: MenuState;
  page: Page;
  save?: {
    dirty: boolean;
    busy: boolean;
    saved: boolean;
    error: string;
    onSave: () => void;
  };
  children: ReactNode;
}) {
  // A page with a Save button is a form (Enter saves); one without holds its own forms.
  const body = (
    <>
      <header className="pg-top pg-settings-head">
        <ShowMenuButton state={menu} />
        <div>
          <h2 id="settings-title">{page.label}</h2>
          <p className="pg-muted">{page.description}</p>
        </div>
        {save && (
          <div className="pg-settings-save">
            <span role="status" className="pg-muted">
              {save.busy ? "Saving…" : save.saved && !save.dirty ? "Saved" : ""}
            </span>
            <button
              type="submit"
              className="pg-primary"
              disabled={!save.dirty || save.busy}
            >
              <Save size={14} aria-hidden="true" /> Save
            </button>
          </div>
        )}
      </header>
      <div className="pg-settings-body">
        {save?.error && (
          <p role="alert" className="pg-attr-error">
            {save.error}
          </p>
        )}
        {children}
      </div>
    </>
  );
  return save ? (
    <form
      className="pg-settings-page"
      aria-labelledby="settings-title"
      onSubmit={(e) => {
        e.preventDefault();
        if (save.dirty && !save.busy) save.onSave();
      }}
    >
      {body}
    </form>
  ) : (
    <div
      className="pg-settings-page"
      aria-labelledby="settings-title"
      role="region"
    >
      {body}
    </div>
  );
}
export function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const id = "card-" + title.toLowerCase().replace(/[^a-z]+/g, "-");
  return (
    <section className="pg-settings-card" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {description && <p className="pg-muted">{description}</p>}
      {children}
    </section>
  );
}
/** A labelled field with an optional explanation under it. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string, hintId?: string) => ReactNode;
}) {
  const id = "f-" + label.toLowerCase().replace(/[^a-z]+/g, "-");
  return (
    <div className="pg-settings-field">
      <label htmlFor={id}>{label}</label>
      {children(id, hint ? id + "-hint" : undefined)}
      {hint && (
        <small id={id + "-hint"} className="pg-muted">
          {hint}
        </small>
      )}
    </div>
  );
}
/** Load, edit, save: a page's form state with dirty tracking. */
export function useForm<T>(
  section: string,
  toForm: (data: Record<string, unknown>) => T,
) {
  const [saved, setSaved] = useState<T | null>(null);
  const [form, setForm] = useState<T | null>(null);
  const [extra, setExtra] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Record<string, unknown>>("settings?section=" + section)
      .then((data) => {
        const f = toForm(data);
        setSaved(f);
        setForm(f);
        setExtra(data);
      })
      .catch((e) => setError(message(e, "This page could not be loaded.")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);
  const dirty = !!form && JSON.stringify(form) !== JSON.stringify(saved);
  async function save(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const data = await api<Record<string, unknown>>("settings", body);
      const f = toForm(data);
      setSaved(f);
      setForm(f);
      setExtra(data);
      setDone(true);
      return data;
    } catch (e) {
      setError(message(e, "Your changes could not be saved."));
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { form, setForm, extra, dirty, busy, done, error, save };
}
