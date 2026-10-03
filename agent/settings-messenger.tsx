import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { api } from "./api";
import {
  Card,
  Field,
  Frame,
  message,
  type MenuState,
  type Page,
} from "./settings-ui";
import {
  LANGUAGES,
  languageName,
  type Brand,
  type Brands,
} from "./settings-channels";
import {
  IdentityGuide,
  InstallCard,
  type InstallStatus,
} from "./messenger-install";
import { INTERFACE_LANGUAGES as INTERFACE } from "../lib/messenger-languages";
import { HEX, onColour, palette, type Palette } from "../lib/brand-colours";
import { ImageField, imageSource } from "./messenger-assets";
import type {
  AudienceConfig,
  HomeCard,
  MessengerConfig,
  Space,
} from "../server/messenger-config";

/**
 * Settings › Messenger with drafts (messenger settings M1; docs/MESSENGER_SETTINGS_STEP1.md).
 * Everything the customer sees is edited as a draft: Save keeps it, "Save and set live" puts it
 * live as a new version, Discard goes back to what's live, and an earlier version can be restored
 * into the draft. Visitors and signed-in users each get their own spaces, opening, launcher and
 * start button; Home cards say who sees them. Identity verification is a security setting, saved
 * at once rather than drafted.
 *
 * Laid out as Intercom's messenger settings are (M4; docs/MESSENGER_SETTINGS_STEP4.md): tabs for
 * Widget (Content and Appearance), Conversations, General, Install and Security; each a list of
 * sections that open one at a time, with a Visitors/Users switch inside the sections that differ
 * by audience; and the preview beside them, following the open section.
 */
export type DraftState = {
  brandId: string;
  draft: MessengerConfig;
  draftVersion: string;
  live: MessengerConfig;
  liveVersion: number | null;
  changed: boolean;
  /** Where the messenger has run lately, and failed verifications (M3). */
  install?: InstallStatus;
  versions: {
    version: number;
    publishedAt: string;
    publishedBy: string | null;
  }[];
};

type Tab = "widget" | "conversations" | "general" | "install" | "security";
type Area = "content" | "appearance" | "conversations" | "general";
type Who = "visitors" | "users";
type Scheme = "as-set" | "light" | "dark";
/** Where the page is: kept outside the editor, which starts afresh from each saved draft. */
export type MessengerView = {
  tab: Tab;
  widget: "content" | "appearance";
  /** The open section in each area (one at a time), if any. */
  open: Partial<Record<Area, string>>;
  who: Who;
  scheme: Scheme;
  /** The space the preview shows. */
  page: Space;
  /** The theme whose colours are being edited. */
  colours: "light" | "dark";
};
const START_VIEW: MessengerView = {
  tab: "widget",
  widget: "content",
  open: {},
  who: "visitors",
  scheme: "as-set",
  page: "home",
  colours: "light",
};

/** The draft for a brand: undefined while loading, null when drafts are off for the workspace. */
export function useMessengerDrafts(brandId: string | null) {
  const [state, setState] = useState<DraftState | null | undefined>(undefined);
  // Kept here, so they survive the editor starting afresh from each saved draft.
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<MessengerView>(START_VIEW);
  useEffect(() => {
    if (!brandId) return;
    let live = true;
    api<DraftState>("messenger?brand=" + encodeURIComponent(brandId))
      .then((s) => live && setState(s))
      // Drafts off for the workspace (or unavailable): the earlier page.
      .catch(() => live && setState(null));
    return () => {
      live = false;
    };
  }, [brandId]);
  return { state, setState, notice, setNotice, view, setView };
}

const TABS: [Tab, string][] = [
  ["widget", "Widget"],
  ["conversations", "Conversations"],
  ["general", "General"],
  ["install", "Install"],
  ["security", "Security"],
];
const SPACE_NAMES: Record<Space, [string, string]> = {
  home: ["Home", "The welcome, and the cards below."],
  messages: ["Messages", "Their conversations. Always shown."],
  help: ["Help", "Search and read the help center."],
  tickets: ["Tickets", "Their tickets and requests (signed-in users only)."],
};
const START: [AudienceConfig["startButton"], string][] = [
  ["send", "Send us a message"],
  ["ask", "Ask a question"],
  ["chat", "Chat with us"],
  ["start", "Start a conversation"],
  ["contact", "Contact us"],
  ["support", "Contact support"],
];
const CARDS: [HomeCard["type"], string, string][] = [
  ["start", "Start a conversation", "The start button, with its wording."],
  ["search", "Search help", "Opens the Help space."],
  ["recent", "Recent conversations", "Their latest three conversations."],
  ["link", "Link", "A titled link to a page of yours (https)."],
  ["announcement", "Announcement", "A short note with a title."],
  ["tickets", "Your tickets", "Opens their requests (signed-in users only)."],
];
const AUDIENCES = [
  ["visitors", "Visitors", "People who aren't signed in."],
  ["users", "Users", "Signed-in customers whose identity is verified."],
] as const;
const SHOW: Record<AudienceConfig["launcher"]["show"], string> = {
  always: "On every page",
  only_matching: "Only on pages that match",
  except_matching: "On every page except those that match",
  never: "Never",
};
const THEMES: Record<MessengerConfig["theme"], string> = {
  auto: "Match the visitor's device",
  light: "Light",
  dark: "Dark",
};
const cardName = (t: HomeCard["type"]) =>
  CARDS.find(([v]) => v === t)?.[1] ?? t;
const when = (iso: string) => new Date(iso).toLocaleString();
const onOff = (on: boolean) => (on ? "On" : "Off");

/** A section that opens and closes; closed, it says what's set. */
function Section({
  id,
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="pg-accordion" data-open={open || undefined}>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={"section-" + id}
          onClick={onToggle}
        >
          <span>
            <strong>{title}</strong>
            {!open && <small className="pg-muted">{summary}</small>}
          </span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </h3>
      {open && (
        <div
          id={"section-" + id}
          className="pg-accordion-body"
          role="region"
          aria-label={title}
        >
          {children}
        </div>
      )}
    </section>
  );
}

/** A colour, picked or typed, with a sample of text on it. */
function ColourField({
  label,
  value,
  shade,
  onChange,
}: {
  label: string;
  value: string;
  shade: Palette | null;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      {(id) => (
        <span className="pg-settings-colour">
          <input
            type="color"
            aria-label={`Pick the ${label.toLowerCase()}`}
            value={HEX.test(value) ? value : "#000000"}
            onChange={(e) => onChange(e.target.value)}
          />
          <input
            id={id}
            value={value}
            maxLength={7}
            onChange={(e) => onChange(e.target.value)}
          />
          {shade && (
            <span
              className="pg-colour-sample"
              role="img"
              aria-label={`${label} sample`}
              style={{ background: shade.accent, color: shade.onAccent }}
            >
              Aa
            </span>
          )}
        </span>
      )}
    </Field>
  );
}
const readability = (shade: Palette, way: "darker" | "lighter") =>
  `Text on it is ${shade.onAccent === "#ffffff" ? "white" : "black"}, whichever reads better.` +
  (shade.accentText !== shade.accent
    ? ` Links use ${shade.accentText}, a ${way} shade of it, so they stay readable.`
    : "");

export function MessengerDrafts({
  menu,
  page,
  data,
  brand,
  state,
  onBrand,
  onState,
  onIdentity,
  notice,
  setNotice,
  view,
  setView,
}: {
  menu: MenuState;
  page: Page;
  data: Brands;
  brand: Brand;
  state: DraftState;
  onBrand: (id: string) => void;
  onState: (s: DraftState) => void;
  /** Identity settings saved (they aren't drafted): the brand list reloads. */
  onIdentity: () => void;
  notice: string;
  setNotice: (text: string) => void;
  view: MessengerView;
  setView: (view: MessengerView) => void;
}) {
  const [form, setForm] = useState<MessengerConfig>(state.draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [website, setWebsite] = useState("");
  const [newCard, setNewCard] = useState<HomeCard["type"]>("link");
  const [newLanguage, setNewLanguage] = useState("");
  const [restore, setRestore] = useState("");
  const dirty = JSON.stringify(form) !== JSON.stringify(state.draft);
  const who = view.who;
  const aud = form.audiences[who];
  const set = <K extends keyof MessengerConfig>(k: K, v: MessengerConfig[K]) =>
    setForm({ ...form, [k]: v });
  const setLook = (change: Partial<MessengerConfig["look"]>) =>
    set("look", { ...form.look, ...change });
  const setHeader = (change: Partial<MessengerConfig["look"]["header"]>) =>
    setLook({ header: { ...form.look.header, ...change } });
  const setGeneral = (change: Partial<MessengerConfig["general"]>) =>
    set("general", { ...form.general, ...change });
  const setPrivacy = (change: Partial<MessengerConfig["general"]["privacy"]>) =>
    setGeneral({ privacy: { ...form.general.privacy, ...change } });
  const setAud = (change: Partial<AudienceConfig>) =>
    set("audiences", { ...form.audiences, [who]: { ...aud, ...change } });
  const languages = Object.keys(form.welcome);
  const colours = palette(form.color, form.look.darkColor);

  async function send(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await api<DraftState>("messenger", {
        brandId: brand.id,
        draftVersion: state.draftVersion,
        ...body,
      });
      setNotice(done);
      onState(next);
      return next;
    } catch (e) {
      setError(message(e, "The messenger could not be saved."));
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    // Unsaved edits are saved first, then the saved draft is published.
    let version = state.draftVersion;
    if (dirty) {
      const saved = await send({ action: "save", config: form }, "Saved.");
      if (!saved) return;
      version = saved.draftVersion;
    }
    setBusy(true);
    setError("");
    try {
      const next = await api<DraftState>("messenger", {
        brandId: brand.id,
        draftVersion: version,
        action: "publish",
      });
      setNotice(
        `Published version ${next.liveVersion}. Customers see it the next time the messenger opens.`,
      );
      onState(next);
    } catch (e) {
      setError(message(e, "The messenger could not be published."));
    } finally {
      setBusy(false);
    }
  }
  const move = <T,>(list: T[], i: number, by: -1 | 1) => {
    const next = [...list];
    const [x] = next.splice(i, 1);
    next.splice(i + by, 0, x);
    return next;
  };

  const area: Area | null =
    view.tab === "widget"
      ? view.widget
      : view.tab === "conversations" || view.tab === "general"
        ? view.tab
        : null;
  /** A section of the current area; opening it shows its space in the preview. */
  const section = (
    id: string,
    title: string,
    summary: string,
    shows: Space | null,
    children: ReactNode,
  ) => {
    const open = !!area && view.open[area] === id;
    return (
      <Section
        key={id}
        id={id}
        title={title}
        summary={summary}
        open={open}
        onToggle={() => {
          if (area)
            setView({
              ...view,
              open: { ...view.open, [area]: open ? undefined : id },
              page: !open && shows ? shows : view.page,
            });
        }}
      >
        {children}
      </Section>
    );
  };
  /** The Visitors/Users switch inside a section that differs by audience. */
  const audienceSwitch = (what: string) => (
    <div
      className="pg-settings-audience"
      role="radiogroup"
      aria-label="Audience"
    >
      {AUDIENCES.map(([value, label, help]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={who === value}
          title={help}
          onClick={() => setView({ ...view, who: value })}
        >
          {label}
        </button>
      ))}
      <small className="pg-muted">
        {AUDIENCES.find(([v]) => v === who)![2]} {what} for{" "}
        {who === "visitors" ? "visitors" : "users"}.
      </small>
    </div>
  );

  const content = [
    section(
      "spaces",
      "Spaces",
      aud.spaces.map((s) => SPACE_NAMES[s][0]).join(", "),
      "home",
      <>
        <p className="pg-muted pg-settings-small">
          The tabs along the bottom of the messenger, in order.
        </p>
        {audienceSwitch("These spaces are")}
        <ul className="pg-settings-list" aria-label="Spaces">
          {(["home", "messages", "help", "tickets"] as Space[])
            .sort((a, b) => {
              const ia = aud.spaces.indexOf(a),
                ib = aud.spaces.indexOf(b);
              return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
            })
            .map((s) => {
              const on = aud.spaces.includes(s);
              const i = aud.spaces.indexOf(s);
              const fixed = s === "messages";
              const blocked = s === "tickets" && who === "visitors";
              return (
                <li key={s}>
                  <label className="pg-settings-toggle">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={fixed || blocked}
                      onChange={(e) =>
                        setAud({
                          spaces: e.target.checked
                            ? [...aud.spaces, s]
                            : aud.spaces.filter((x) => x !== s),
                        })
                      }
                    />
                    <span>
                      <strong>{SPACE_NAMES[s][0]}</strong>
                      <small className="pg-muted">
                        {blocked
                          ? "For signed-in users only."
                          : SPACE_NAMES[s][1]}
                      </small>
                    </span>
                  </label>
                  {on && (
                    <span className="pg-settings-buttons">
                      <button
                        type="button"
                        aria-label={`Move ${SPACE_NAMES[s][0]} earlier`}
                        disabled={i === 0}
                        onClick={() =>
                          setAud({ spaces: move(aud.spaces, i, -1) })
                        }
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${SPACE_NAMES[s][0]} later`}
                        disabled={i === aud.spaces.length - 1}
                        onClick={() =>
                          setAud({ spaces: move(aud.spaces, i, 1) })
                        }
                      >
                        ↓
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
        </ul>
      </>,
    ),
    section(
      "launch",
      "Launch directly into a conversation",
      onOff(aud.launchToConversation),
      aud.launchToConversation ? "messages" : "home",
      <>
        {audienceSwitch("This is")}
        <label className="pg-settings-toggle">
          <input
            type="checkbox"
            checked={aud.launchToConversation}
            onChange={(e) => {
              setAud({ launchToConversation: e.target.checked });
              setView({ ...view, page: e.target.checked ? "messages" : "home" });
            }}
          />
          <span>
            <strong>Open straight into a conversation</strong>
            <small className="pg-muted">
              Skip Home: a new message, or their most recent conversation.
            </small>
          </span>
        </label>
      </>,
    ),
    section(
      "welcome",
      "Set your welcome message",
      form.welcome[form.locale]?.greeting || "Not set",
      "home",
      <>
        <p className="pg-muted pg-settings-small">
          The greeting and introduction at the top of Home, in each language.
          {" {first_name}"} becomes a signed-in customer&apos;s first name, and
          is left out for visitors.
        </p>
        {languages.map((l) => (
          <fieldset key={l} className="pg-settings-fieldset">
            <legend>
              {languageName(l)}
              {l === form.locale && " (the messenger's language)"}
            </legend>
            <div className="pg-settings-row">
              <Field label={`Greeting (${languageName(l)})`}>
                {(id) => (
                  <input
                    id={id}
                    maxLength={120}
                    value={form.welcome[l].greeting}
                    onChange={(e) =>
                      set("welcome", {
                        ...form.welcome,
                        [l]: { ...form.welcome[l], greeting: e.target.value },
                      })
                    }
                  />
                )}
              </Field>
              <button
                type="button"
                onClick={() =>
                  set("welcome", {
                    ...form.welcome,
                    [l]: {
                      ...form.welcome[l],
                      greeting: (
                        form.welcome[l].greeting + " {first_name}"
                      ).trim(),
                    },
                  })
                }
              >
                Insert first name
              </button>
            </div>
            <Field label={`Introduction (${languageName(l)})`}>
              {(id) => (
                <input
                  id={id}
                  maxLength={160}
                  value={form.welcome[l].intro}
                  onChange={(e) =>
                    set("welcome", {
                      ...form.welcome,
                      [l]: { ...form.welcome[l], intro: e.target.value },
                    })
                  }
                />
              )}
            </Field>
            {l !== form.locale && (
              <div>
                <button
                  type="button"
                  onClick={() => {
                    const rest = Object.fromEntries(
                      Object.entries(form.welcome).filter(([k]) => k !== l),
                    );
                    const notes = Object.fromEntries(
                      Object.entries(form.notice.text).filter(([k]) => k !== l),
                    );
                    setForm({
                      ...form,
                      welcome: rest,
                      notice: { ...form.notice, text: notes },
                    });
                  }}
                >
                  Remove {languageName(l)}
                </button>
              </div>
            )}
          </fieldset>
        ))}
        <div className="pg-settings-row">
          <select
            aria-label="Add a language"
            value={newLanguage}
            onChange={(e) => setNewLanguage(e.target.value)}
          >
            <option value="">Add a language…</option>
            {LANGUAGES.filter((l) => !languages.includes(l)).map((l) => (
              <option key={l} value={l}>
                {languageName(l)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!newLanguage}
            onClick={() => {
              set("welcome", {
                ...form.welcome,
                [newLanguage]: { greeting: "", intro: "" },
              });
              setNewLanguage("");
            }}
          >
            Add language
          </button>
        </div>
      </>,
    ),
    section(
      "home",
      "Customize Home with cards",
      form.home.map((c) => cardName(c.type)).join(", ") || "No cards",
      "home",
      <>
        <p className="pg-muted pg-settings-small">
          The cards under the welcome on Home, in order. Each card says who
          sees it.
        </p>
        <ul className="pg-settings-list" aria-label="Home cards">
          {form.home.map((c, i) => (
            <li key={c.id} className="pg-settings-card-row">
              <span>
                <strong>{cardName(c.type)}</strong>
                <span className="pg-settings-row">
                  <select
                    aria-label={`${cardName(c.type)} ${i + 1}: who sees it`}
                    value={c.audience}
                    onChange={(e) =>
                      set(
                        "home",
                        form.home.map((x) =>
                          x.id === c.id
                            ? {
                                ...x,
                                audience: e.target
                                  .value as HomeCard["audience"],
                              }
                            : x,
                        ),
                      )
                    }
                  >
                    {c.type !== "tickets" && (
                      <option value="everyone">Everyone</option>
                    )}
                    {c.type !== "tickets" && (
                      <option value="visitors">Visitors only</option>
                    )}
                    <option value="users">Users only</option>
                  </select>
                  {(c.type === "link" || c.type === "announcement") && (
                    <input
                      aria-label={`${cardName(c.type)} ${i + 1}: title`}
                      placeholder="Title"
                      maxLength={80}
                      value={c.title ?? ""}
                      onChange={(e) =>
                        set(
                          "home",
                          form.home.map((x) =>
                            x.id === c.id ? { ...x, title: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  )}
                  {(c.type === "link" || c.type === "announcement") && (
                    <input
                      aria-label={`${cardName(c.type)} ${i + 1}: text`}
                      placeholder="Text (optional)"
                      maxLength={300}
                      value={c.body ?? ""}
                      onChange={(e) =>
                        set(
                          "home",
                          form.home.map((x) =>
                            x.id === c.id ? { ...x, body: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  )}
                  {c.type === "link" && (
                    <input
                      aria-label={`${cardName(c.type)} ${i + 1}: address`}
                      placeholder="https://"
                      maxLength={500}
                      value={c.url ?? ""}
                      onChange={(e) =>
                        set(
                          "home",
                          form.home.map((x) =>
                            x.id === c.id ? { ...x, url: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  )}
                </span>
              </span>
              <span className="pg-settings-buttons">
                <button
                  type="button"
                  aria-label={`Move ${cardName(c.type)} ${i + 1} up`}
                  disabled={i === 0}
                  onClick={() => set("home", move(form.home, i, -1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move ${cardName(c.type)} ${i + 1} down`}
                  disabled={i === form.home.length - 1}
                  onClick={() => set("home", move(form.home, i, 1))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${cardName(c.type)} ${i + 1}`}
                  onClick={() =>
                    set(
                      "home",
                      form.home.filter((x) => x.id !== c.id),
                    )
                  }
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
        <div className="pg-settings-row">
          <select
            aria-label="New card kind"
            value={newCard}
            onChange={(e) => setNewCard(e.target.value as HomeCard["type"])}
          >
            {CARDS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={form.home.length >= 12}
            onClick={() =>
              set("home", [
                ...form.home,
                {
                  id: "card-" + crypto.randomUUID().slice(0, 8),
                  type: newCard,
                  audience: newCard === "tickets" ? "users" : "everyone",
                  ...(newCard === "link" || newCard === "announcement"
                    ? { title: "", body: "" }
                    : {}),
                  ...(newCard === "link" ? { url: "" } : {}),
                },
              ])
            }
          >
            Add card
          </button>
          <small className="pg-muted">
            {CARDS.find(([v]) => v === newCard)![2]}
          </small>
        </div>
      </>,
    ),
    section(
      "launcher",
      "Show the Messenger launcher",
      SHOW[aud.launcher.show],
      "home",
      <>
        {audienceSwitch("Where the launcher shows is")}
        <Field
          label="Show the launcher"
          hint="The button that opens the messenger. Your site's own code can still open it when hidden."
        >
          {(id, hint) => (
            <select
              id={id}
              aria-describedby={hint}
              value={aud.launcher.show}
              onChange={(e) =>
                setAud({
                  launcher: {
                    ...aud.launcher,
                    show: e.target.value as AudienceConfig["launcher"]["show"],
                  },
                })
              }
            >
              {Object.entries(SHOW).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </Field>
        {(aud.launcher.show === "only_matching" ||
          aud.launcher.show === "except_matching") && (
          <fieldset className="pg-settings-fieldset">
            <legend>Pages that match</legend>
            <p className="pg-muted pg-settings-small">
              Compared with the page&apos;s full address, such as
              https://shop.example.com/pricing.
            </p>
            {aud.launcher.rules.map((r, i) => (
              <div key={i} className="pg-settings-row">
                <select
                  aria-label={`Rule ${i + 1} kind`}
                  value={r.op}
                  onChange={(e) =>
                    setAud({
                      launcher: {
                        ...aud.launcher,
                        rules: aud.launcher.rules.map((x, j) =>
                          j === i
                            ? { ...x, op: e.target.value as typeof r.op }
                            : x,
                        ),
                      },
                    })
                  }
                >
                  <option value="contains">Address contains</option>
                  <option value="starts_with">Address starts with</option>
                  <option value="equals">Address is exactly</option>
                </select>
                <input
                  aria-label={`Rule ${i + 1} text`}
                  value={r.value}
                  maxLength={300}
                  placeholder="/pricing"
                  onChange={(e) =>
                    setAud({
                      launcher: {
                        ...aud.launcher,
                        rules: aud.launcher.rules.map((x, j) =>
                          j === i ? { ...x, value: e.target.value } : x,
                        ),
                      },
                    })
                  }
                />
                <button
                  type="button"
                  aria-label={`Remove rule ${i + 1}`}
                  onClick={() =>
                    setAud({
                      launcher: {
                        ...aud.launcher,
                        rules: aud.launcher.rules.filter((_, j) => j !== i),
                      },
                    })
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                onClick={() =>
                  setAud({
                    launcher: {
                      ...aud.launcher,
                      rules: [
                        ...aud.launcher.rules,
                        { op: "contains", value: "" },
                      ],
                    },
                  })
                }
              >
                Add page rule
              </button>
            </div>
          </fieldset>
        )}
      </>,
    ),
  ];

  const dark = view.colours === "dark";
  const appearance = [
    section(
      "brand",
      "Brand",
      brand.name,
      "home",
      data.brands.length > 1 ? (
        <Field
          label="Brand"
          hint="Each brand has its own messenger. Save first: changing brand leaves unsaved changes behind."
        >
          {(id, hint) => (
            <select
              id={id}
              aria-describedby={hint}
              value={brand.id}
              onChange={(e) => onBrand(e.target.value)}
            >
              {data.brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : (
        <p className="pg-muted pg-settings-small">
          This is {brand.name}&apos;s messenger. Each brand has its own; add
          one in <a href="#settings/brands">Brands</a>.
        </p>
      ),
    ),
    section(
      "theme",
      "Messenger theme and branding",
      `${THEMES[form.theme]} · ${form.color}${form.look.darkColor ? " / " + form.look.darkColor : ""}`,
      "home",
      <>
        <Field
          label="Colour scheme"
          hint="Light, dark, or whichever the visitor's device uses."
        >
          {(id, hint) => (
            <select
              id={id}
              aria-describedby={hint}
              value={form.theme}
              onChange={(e) =>
                set("theme", e.target.value as typeof form.theme)
              }
            >
              {Object.entries(THEMES).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div
          className="pg-settings-tabs"
          role="tablist"
          aria-label="Theme colours"
        >
          {(
            [
              ["light", "Light theme"],
              ["dark", "Dark theme"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view.colours === v}
              onClick={() => setView({ ...view, colours: v, scheme: v })}
            >
              {label}
            </button>
          ))}
        </div>
        <div role="tabpanel" aria-label={dark ? "Dark theme" : "Light theme"}>
          {!dark ? (
            <>
              <ColourField
                label="Primary colour"
                value={form.color}
                shade={HEX.test(form.color) ? colours.light : null}
                onChange={(v) => set("color", v)}
              />
              <p
                className="pg-muted pg-settings-small"
                data-testid="readability"
              >
                Buttons, the customer&apos;s messages and the launcher.{" "}
                {HEX.test(form.color)
                  ? readability(colours.light, "darker")
                  : "Type a colour such as #1d4ed8."}
              </p>
            </>
          ) : (
            <>
              <label className="pg-settings-toggle">
                <input
                  type="checkbox"
                  checked={form.look.darkColor === null}
                  onChange={(e) =>
                    setLook({
                      darkColor: e.target.checked ? null : form.color,
                    })
                  }
                />
                <span>
                  <strong>Use the light theme&apos;s primary colour</strong>
                  <small className="pg-muted">
                    Or choose one that suits a dark background.
                  </small>
                </span>
              </label>
              {form.look.darkColor !== null && (
                <ColourField
                  label="Primary colour (dark theme)"
                  value={form.look.darkColor}
                  shade={HEX.test(form.look.darkColor) ? colours.dark : null}
                  onChange={(v) => setLook({ darkColor: v })}
                />
              )}
              <p
                className="pg-muted pg-settings-small"
                data-testid="readability"
              >
                {readability(colours.dark, "lighter")}
              </p>
            </>
          )}
        </div>
        <ImageField
          label="Home screen logo"
          hint="Shown at the top of the messenger. PNG, JPG or GIF up to 1 MB; a square image works best."
          brandId={brand.id}
          purpose="home_logo"
          value={form.logo}
          onChange={(v) => set("logo", v)}
        />
        <ImageField
          label="Launcher logo"
          hint={`Shown in the launcher instead of ✦; 72 × 72 pixels with a transparent background works best. If your site sets a content security policy, add ${data.apiOrigin} to its img-src.`}
          brandId={brand.id}
          purpose="launcher_logo"
          value={form.look.launcherLogo}
          onChange={(v) => setLook({ launcherLogo: v })}
        />
        <Field label="Home background">
          {(id) => (
            <select
              id={id}
              value={form.look.header.background}
              onChange={(e) =>
                setHeader({
                  background: e.target
                    .value as typeof form.look.header.background,
                  // A colour or gradient starts from the brand's colour.
                  colors:
                    e.target.value === "gradient" &&
                    form.look.header.colors.length < 2
                      ? [form.look.header.colors[0] ?? form.color, "#1d3a8a"]
                      : e.target.value === "solid" &&
                          form.look.header.background === "none"
                        ? [form.color]
                        : form.look.header.colors,
                })
              }
            >
              <option value="none">None</option>
              <option value="solid">A colour</option>
              <option value="gradient">A gradient</option>
              <option value="image">An image</option>
            </select>
          )}
        </Field>
        {(form.look.header.background === "solid" ||
          form.look.header.background === "gradient") && (
          <div className="pg-settings-row">
            {form.look.header.colors
              .slice(0, form.look.header.background === "solid" ? 1 : 3)
              .map((c, i) => (
                <span key={i} className="pg-settings-colour">
                  <input
                    type="color"
                    aria-label={`Background colour ${i + 1}`}
                    value={c}
                    onChange={(e) =>
                      setHeader({
                        colors: form.look.header.colors.map((x, j) =>
                          j === i ? e.target.value : x,
                        ),
                      })
                    }
                  />
                  {form.look.header.background === "gradient" &&
                    form.look.header.colors.length > 2 && (
                      <button
                        type="button"
                        aria-label={`Remove colour ${i + 1}`}
                        onClick={() =>
                          setHeader({
                            colors: form.look.header.colors.filter(
                              (_, j) => j !== i,
                            ),
                          })
                        }
                      >
                        ×
                      </button>
                    )}
                </span>
              ))}
            {form.look.header.background === "gradient" &&
              form.look.header.colors.length < 3 && (
                <button
                  type="button"
                  onClick={() =>
                    setHeader({
                      colors: [...form.look.header.colors, "#ffffff"],
                    })
                  }
                >
                  Add colour
                </button>
              )}
          </div>
        )}
        {form.look.header.background === "image" && (
          <ImageField
            label="Background image"
            hint="It covers the welcome. PNG, JPG or GIF up to 1 MB."
            brandId={brand.id}
            purpose="home_background"
            value={form.look.header.image}
            onChange={(v) => setHeader({ image: v })}
          />
        )}
        {form.look.header.background !== "none" && (
          <>
            <fieldset className="pg-settings-fieldset">
              <legend>Header text colour</legend>
              <div className="pg-settings-checks">
                {(
                  [
                    ["light", "White"],
                    ["dark", "Black"],
                  ] as const
                ).map(([v, label]) => (
                  <label key={v}>
                    <input
                      type="radio"
                      name="header-text"
                      checked={form.look.header.text === v}
                      onChange={() => setHeader({ text: v })}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="pg-settings-toggle">
              <input
                type="checkbox"
                checked={form.look.header.fade}
                onChange={(e) => setHeader({ fade: e.target.checked })}
              />
              <span>
                <strong>Fade the background into the page</strong>
              </span>
            </label>
          </>
        )}
      </>,
    ),
    section(
      "avatars",
      "Teammate avatars",
      onOff(form.look.showTeammates),
      "home",
      <label className="pg-settings-toggle">
        <input
          type="checkbox"
          checked={form.look.showTeammates}
          onChange={(e) => setLook({ showTeammates: e.target.checked })}
        />
        <span>
          <strong>Show teammates on Home</strong>
          <small className="pg-muted">
            Up to three teammates&apos; initials, active ones first, with their
            first names on hover.
          </small>
        </span>
      </label>,
    ),
    section(
      "position",
      "Launcher position",
      `${form.position === "left" ? "Bottom left" : "Bottom right"} · ${form.look.launcherSpacing.side} px from the side, ${form.look.launcherSpacing.bottom} px from the bottom`,
      null,
      <>
        <div className="pg-settings-row">
          <Field label="Launcher side">
            {(id) => (
              <select
                id={id}
                value={form.position}
                onChange={(e) =>
                  set("position", e.target.value as typeof form.position)
                }
              >
                <option value="right">Bottom right</option>
                <option value="left">Bottom left</option>
              </select>
            )}
          </Field>
          <Field label="Launcher shape">
            {(id) => (
              <select
                id={id}
                value={form.shape}
                onChange={(e) =>
                  set("shape", e.target.value as typeof form.shape)
                }
              >
                <option value="rounded">Rounded square</option>
                <option value="circle">Circle</option>
              </select>
            )}
          </Field>
        </div>
        <div className="pg-settings-row">
          <Field
            label="Side spacing (px)"
            hint="On computers and tablets. Phones use the bottom right corner."
          >
            {(id, hint) => (
              <input
                id={id}
                aria-describedby={hint}
                type="number"
                min={0}
                max={120}
                value={form.look.launcherSpacing.side}
                onChange={(e) =>
                  setLook({
                    launcherSpacing: {
                      ...form.look.launcherSpacing,
                      side: Number(e.target.value),
                    },
                  })
                }
              />
            )}
          </Field>
          <Field label="Bottom spacing (px)">
            {(id) => (
              <input
                id={id}
                type="number"
                min={0}
                max={120}
                value={form.look.launcherSpacing.bottom}
                onChange={(e) =>
                  setLook({
                    launcherSpacing: {
                      ...form.look.launcherSpacing,
                      bottom: Number(e.target.value),
                    },
                  })
                }
              />
            )}
          </Field>
        </div>
      </>,
    ),
  ];

  const conversations = [
    section(
      "start",
      "Start conversation button text",
      START.find(([v]) => v === aud.startButton)?.[1] ?? "",
      "home",
      <>
        {audienceSwitch("This wording is")}
        <div
          className="pg-settings-checks"
          role="radiogroup"
          aria-label="Start button wording"
        >
          {START.map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name={`start-${who}`}
                checked={aud.startButton === value}
                onChange={() => setAud({ startButton: value })}
              />
              {label}
            </label>
          ))}
        </div>
      </>,
    ),
    section(
      "reply",
      "Reply expectations",
      form.general.replyTimes === "always"
        ? "Shown as soon as the messenger opens"
        : "Shown once a team has the conversation",
      "home",
      <>
        <fieldset className="pg-settings-fieldset">
          <legend>Reply times and office hours on Home</legend>
          {(
            [
              ["always", "Always", "As soon as the messenger opens."],
              [
                "after_team",
                "Once a team has the conversation",
                "Best when each team has its own office hours.",
              ],
            ] as const
          ).map(([v, label, help]) => (
            <label key={v} className="pg-settings-toggle">
              <input
                type="radio"
                name="reply-times"
                checked={form.general.replyTimes === v}
                onChange={() => setGeneral({ replyTimes: v })}
              />
              <span>
                <strong>{label}</strong>
                <small className="pg-muted">{help}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <Field label="Away message" hint="Shown outside office hours.">
          {(id, hint) => (
            <textarea
              id={id}
              aria-describedby={hint}
              rows={2}
              maxLength={500}
              value={form.outOfHours}
              onChange={(e) => set("outOfHours", e.target.value)}
            />
          )}
        </Field>
      </>,
    ),
    section(
      "intro",
      "Team introduction",
      form.teamIntroduction || "Not set",
      "home",
      <Field
        label="Team introduction"
        hint="Above the welcome, such as who answers and when."
      >
        {(id, hint) => (
          <input
            id={id}
            aria-describedby={hint}
            maxLength={200}
            value={form.teamIntroduction}
            onChange={(e) => set("teamIntroduction", e.target.value)}
          />
        )}
      </Field>,
    ),
    section(
      "notice",
      "Special notice",
      form.notice.enabled ? "Showing" : "Off",
      "home",
      <>
        <p className="pg-muted pg-settings-small">
          A short notice at the top of Home and Messages for everyone, such as
          a delay or an outage.
        </p>
        <label className="pg-settings-toggle">
          <input
            type="checkbox"
            checked={form.notice.enabled}
            onChange={(e) =>
              set("notice", { ...form.notice, enabled: e.target.checked })
            }
          />
          <span>
            <strong>Show the notice</strong>
          </span>
        </label>
        {languages.map((l) => (
          <Field key={l} label={`Notice (${languageName(l)})`}>
            {(id) => (
              <textarea
                id={id}
                rows={2}
                maxLength={300}
                value={form.notice.text[l] ?? ""}
                onChange={(e) =>
                  set("notice", {
                    ...form.notice,
                    text: { ...form.notice.text, [l]: e.target.value },
                  })
                }
              />
            )}
          </Field>
        ))}
      </>,
    ),
  ];

  const general = [
    section(
      "inbound",
      "Control inbound volume",
      form.allowVisitors
        ? "Visitors and users can start conversations"
        : "Only signed-in users can start conversations",
      "home",
      <>
        <label className="pg-settings-toggle">
          <input
            type="checkbox"
            checked={form.allowVisitors}
            onChange={(e) => set("allowVisitors", e.target.checked)}
          />
          <span>
            <strong>Visitors can start conversations</strong>
            <small className="pg-muted">
              Off: only signed-in, verified customers can.
            </small>
          </span>
        </label>
        <label className="pg-settings-toggle">
          <input
            type="checkbox"
            checked={form.requireSearch}
            onChange={(e) => set("requireSearch", e.target.checked)}
          />
          <span>
            <strong>Ask visitors to search help first</strong>
          </span>
        </label>
        <fieldset className="pg-settings-fieldset">
          <legend>Conversation rules</legend>
          {audienceSwitch(
            "Relay enforces these, not just the messenger. They are",
          )}
          {(
            [
              [
                "oneConversation",
                "One open conversation at a time",
                "With one open, the messenger continues it instead of starting another.",
              ],
              [
                "talkAfterUnhelpful",
                "Offer a conversation after an article didn't help",
                "“Talk to us” after a “No” on a help article.",
              ],
              [
                "blockClosedReplies",
                "No replies to closed conversations",
                "They start a new conversation instead.",
              ],
              [
                "blockClosedTicketReplies",
                "No replies to closed tickets",
                "Resolved requests stay closed.",
              ],
            ] as const
          ).map(([key, label, help]) => (
            <label key={key} className="pg-settings-toggle">
              <input
                type="checkbox"
                checked={aud.inbound[key]}
                onChange={(e) =>
                  setAud({
                    inbound: { ...aud.inbound, [key]: e.target.checked },
                  })
                }
              />
              <span>
                <strong>{label}</strong>
                <small className="pg-muted">{help}</small>
              </span>
            </label>
          ))}
        </fieldset>
      </>,
    ),
    section(
      "languages",
      "Supported languages",
      [form.locale, ...form.general.languages].map(languageName).join(", "),
      "home",
      <>
        <Field
          label="Messenger language"
          hint="Its own language, used when the website doesn't say which one a visitor reads."
        >
          {(id, hint) => (
            <select
              id={id}
              aria-describedby={hint}
              value={form.locale}
              onChange={(e) => {
                const l = e.target.value;
                // The messenger's own language always has a welcome.
                setForm({
                  ...form,
                  locale: l,
                  welcome: form.welcome[l]
                    ? form.welcome
                    : { ...form.welcome, [l]: { greeting: "", intro: "" } },
                });
              }}
            >
              {[...new Set([form.locale, ...LANGUAGES])].map((l) => (
                <option key={l} value={l}>
                  {languageName(l)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <fieldset className="pg-settings-fieldset">
          <legend>Interface languages</legend>
          <p className="pg-muted pg-settings-small">
            The messenger&apos;s own words in the visitor&apos;s language when
            it&apos;s offered here, otherwise in {languageName(form.locale)}.
            Each was translated by Relay and wants a native speaker&apos;s
            check.
          </p>
          <div className="pg-settings-checks">
            {INTERFACE.filter((l) => l !== form.locale).map((l) => (
              <label key={l}>
                <input
                  type="checkbox"
                  checked={form.general.languages.includes(l)}
                  onChange={(e) =>
                    setGeneral({
                      languages: e.target.checked
                        ? [...form.general.languages, l]
                        : form.general.languages.filter((x) => x !== l),
                    })
                  }
                />
                {languageName(l)}
              </label>
            ))}
          </div>
        </fieldset>
      </>,
    ),
    section(
      "secure",
      "Keep your Messenger secure",
      `${form.allowedOrigins.length} website${form.allowedOrigins.length === 1 ? "" : "s"}`,
      null,
      <>
        <p className="pg-muted pg-settings-small">
          The messenger loads only on these exact addresses, such as
          https://shop.example.com. Each subdomain is listed on its own;
          wildcards aren&apos;t allowed. Identity verification is under
          Security.
        </p>
        <ul className="pg-settings-chips" aria-label="Websites">
          {form.allowedOrigins.map((o) => (
            <li key={o}>
              {o}
              <button
                type="button"
                aria-label={`Remove ${o}`}
                onClick={() =>
                  set(
                    "allowedOrigins",
                    form.allowedOrigins.filter((x) => x !== o),
                  )
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="pg-settings-row">
          <input
            aria-label="Website address"
            placeholder="https://shop.example.com"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
          <button
            type="button"
            onClick={() => {
              const w = website.trim().replace(/\/$/, "");
              if (w && !form.allowedOrigins.includes(w))
                set("allowedOrigins", [...form.allowedOrigins, w]);
              setWebsite("");
            }}
          >
            Add website
          </button>
        </div>
      </>,
    ),
    section(
      "privacy",
      "Configure privacy settings",
      form.general.privacy.enabled ? "Privacy notice on" : "No privacy notice",
      "messages",
      <>
        <label className="pg-settings-toggle">
          <input
            type="checkbox"
            checked={form.general.privacy.enabled}
            onChange={(e) => setPrivacy({ enabled: e.target.checked })}
          />
          <span>
            <strong>Show a privacy notice when a conversation starts</strong>
          </span>
        </label>
        <Field label="Privacy policy address">
          {(id) => (
            <input
              id={id}
              maxLength={500}
              placeholder="https://example.com/privacy"
              value={form.general.privacy.url}
              onChange={(e) => setPrivacy({ url: e.target.value })}
            />
          )}
        </Field>
        {languages.map((l) => (
          <Field key={l} label={`Privacy notice (${languageName(l)})`}>
            {(id) => (
              <input
                id={id}
                maxLength={300}
                placeholder="We use your messages to help you."
                value={form.general.privacy.text[l] ?? ""}
                onChange={(e) =>
                  setPrivacy({
                    text: { ...form.general.privacy.text, [l]: e.target.value },
                  })
                }
              />
            )}
          </Field>
        ))}
      </>,
    ),
    section(
      "other",
      "Other preferences",
      `Reply sound ${form.general.soundDefault ? "on" : "off"} unless the customer changes it`,
      null,
      <label className="pg-settings-toggle">
        <input
          type="checkbox"
          checked={form.general.soundDefault}
          onChange={(e) => setGeneral({ soundDefault: e.target.checked })}
        />
        <span>
          <strong>
            Play a sound for replies, unless the customer turns it off
          </strong>
          <small className="pg-muted">
            Off: customers turn it on in Preferences.
          </small>
        </span>
      </label>,
    ),
  ];

  return (
    <Frame
      menu={menu}
      page={page}
      save={{
        dirty,
        busy,
        saved: false,
        error,
        onSave: () =>
          void send(
            { action: "save", config: form },
            "Draft saved. Save and set live to put it live.",
          ),
        label: "Save draft",
      }}
      actions={
        <button
          type="button"
          className="pg-primary"
          disabled={busy || (!dirty && !state.changed)}
          onClick={() => void publish()}
        >
          Save and set live
        </button>
      }
      wide
    >
      <div className="pg-messenger-layout">
        <div className="pg-messenger-fields">
          {notice && (
            <p role="status" className="pg-settings-notice">
              {notice}
            </p>
          )}
          <div className="pg-messenger-publishing">
            <p className="pg-settings-small" data-testid="publish-state">
              {dirty
                ? "Unsaved changes."
                : state.changed
                  ? "Draft saved, not published yet."
                  : state.liveVersion
                    ? `Live: version ${state.liveVersion}, as published.`
                    : "Live: the messenger as it was set up before drafts. Save and set live to make version 1."}
            </p>
            <div className="pg-settings-row">
              {state.changed && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void send(
                      { action: "discard" },
                      "Draft discarded: it matches what's live again.",
                    )
                  }
                >
                  Discard draft
                </button>
              )}
              {state.versions.length > 0 && (
                <>
                  <select
                    aria-label="Earlier version"
                    value={restore}
                    onChange={(e) => setRestore(e.target.value)}
                  >
                    <option value="">Earlier versions…</option>
                    {state.versions.map((v) => (
                      <option key={v.version} value={v.version}>
                        Version {v.version} · {when(v.publishedAt)}
                        {v.publishedBy ? ` · ${v.publishedBy}` : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busy || !restore}
                    onClick={() =>
                      void send(
                        { action: "restore", version: Number(restore) },
                        `Version ${restore} restored into the draft. Save and set live to put it live.`,
                      )
                    }
                  >
                    Restore into draft
                  </button>
                </>
              )}
            </div>
          </div>

          <div
            className="pg-messenger-tabs"
            role="tablist"
            aria-label="Messenger settings"
          >
            {TABS.map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="tab"
                id={"messenger-tab-" + v}
                aria-selected={view.tab === v}
                aria-controls="messenger-tab-panel"
                onClick={() => setView({ ...view, tab: v })}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            id="messenger-tab-panel"
            role="tabpanel"
            aria-labelledby={"messenger-tab-" + view.tab}
            className="pg-messenger-panel"
          >
            {view.tab === "widget" && (
              <>
                <div
                  className="pg-messenger-segments"
                  role="radiogroup"
                  aria-label="Widget settings"
                >
                  {(
                    [
                      ["content", "Content"],
                      ["appearance", "Appearance"],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      aria-checked={view.widget === v}
                      onClick={() => setView({ ...view, widget: v })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="pg-accordions">
                  {view.widget === "content" ? content : appearance}
                </div>
              </>
            )}
            {view.tab === "conversations" && (
              <div className="pg-accordions">
                {conversations}
                {/* TODO(phase 08 B1): Intercom's "With Fin" settings, for the AI agent. */}
                <p className="pg-muted pg-settings-small">
                  The AI agent&apos;s messenger settings arrive with phase 08.
                </p>
              </div>
            )}
            {view.tab === "general" && (
              <div className="pg-accordions">{general}</div>
            )}
            {view.tab === "install" && (
              <InstallCard
                api={data.apiOrigin}
                workspaceId={data.workspaceId}
                brandId={brand.id}
                status={state.install}
              />
            )}
            {view.tab === "security" && (
              <>
                <IdentityCard data={data} brand={brand} onSaved={onIdentity} />
                <IdentityGuide
                  workspaceId={data.workspaceId}
                  keys={data.identityKeys}
                  status={state.install}
                />
              </>
            )}
          </div>
        </div>
        <Preview
          config={form}
          view={view}
          setView={setView}
          brand={brand}
          workspaceId={data.workspaceId}
        />
      </div>
    </Frame>
  );
}

/** Identity verification: a security setting, saved at once (never drafted). */
function IdentityCard({
  data,
  brand,
  onSaved,
}: {
  data: Brands;
  brand: Brand;
  onSaved: () => void;
}) {
  const [identity, setIdentity] = useState(brand.identity);
  const [state, setState] = useState("");
  const dirty = JSON.stringify(identity) !== JSON.stringify(brand.identity);
  return (
    <Card
      title="Identity verification"
      description="Your server signs each signed-in customer's identity. Saved at once, not drafted, because it protects customers' conversations."
    >
      <label className="pg-settings-toggle">
        <input
          type="checkbox"
          checked={identity.enforced}
          onChange={(e) =>
            setIdentity({ ...identity, enforced: e.target.checked })
          }
        />
        <span>
          <strong>Require verified identities</strong>
        </span>
      </label>
      <label className="pg-settings-toggle">
        <input
          type="checkbox"
          checked={identity.legacyHmac}
          onChange={(e) =>
            setIdentity({ ...identity, legacyHmac: e.target.checked })
          }
        />
        <span>
          <strong>Also accept the older HMAC signature</strong>
        </span>
      </label>
      <p className="pg-muted pg-settings-small">
        Signing keys:{" "}
        {data.identityKeys.map((k) => k.kid).join(", ") || "none installed"}.
      </p>
      <div className="pg-settings-row">
        <button
          type="button"
          disabled={!dirty}
          onClick={async () => {
            try {
              await api("brands", {
                id: brand.id,
                section: "identity",
                enforced: identity.enforced,
                legacyHmac: identity.legacyHmac,
              });
              setState("Saved.");
              onSaved();
            } catch (e) {
              setState(message(e, "Couldn't save."));
            }
          }}
        >
          Save identity settings
        </button>
        <span role="status" className="pg-muted">
          {state}
        </span>
      </div>
    </Card>
  );
}

/**
 * The live preview (messenger M2): the real messenger, loaded from this app's own copy of its
 * page, showing the draft as the chosen audience would see it, on the chosen space and theme
 * (M4). It fetches and sends nothing.
 */
function Preview({
  config,
  view,
  setView,
  brand,
  workspaceId,
}: {
  config: MessengerConfig;
  view: MessengerView;
  setView: (view: MessengerView) => void;
  brand: Brand;
  workspaceId: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useMemo(() => "preview-" + crypto.randomUUID(), []);
  const [ready, setReady] = useState(false);
  const { who, scheme } = view;
  const spaces = config.audiences[who].spaces;
  const shown = spaces.includes(view.page) ? view.page : spaces[0];
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (
        event.source === frame.current?.contentWindow &&
        event.origin === location.origin &&
        event.data?.relay === channel &&
        event.data.type === "ready"
      )
        setReady(true);
    };
    addEventListener("message", listener);
    return () => removeEventListener("message", listener);
  }, [channel]);
  useEffect(() => {
    if (!ready) return;
    const { audiences, home, welcome, notice, general, ...rest } = config;
    // Uploaded images come through the agent app, drafts included (messenger M5).
    const image = (v: string) => imageSource(v, location.origin);
    const { look: draftLook, ...base } = { ...rest, logo: image(config.logo) };
    const look = {
      ...draftLook,
      launcherLogo: image(draftLook.launcherLogo),
      header: { ...draftLook.header, image: image(draftLook.header.image) },
    };
    frame.current?.contentWindow?.postMessage(
      {
        relay: channel,
        type: "initialize",
        api: location.origin,
        open: true,
        page: shown,
        boot: {
          // A new audience starts the messenger afresh; other changes update it in place.
          token: "preview-" + who,
          locale: config.locale,
          session: { workspace: workspaceId, verified: who === "users" },
          brand: {
            id: brand.id,
            name: brand.name,
            ...base,
            theme: scheme === "as-set" ? base.theme : scheme,
            messenger3: {
              audiences,
              home,
              welcome,
              notice,
              look,
              general,
              team: look.showTeammates
                ? [
                    { firstName: "Teammate", initials: "AB" },
                    { firstName: "Teammate", initials: "CD" },
                    { firstName: "Teammate", initials: "EF" },
                  ]
                : [],
            },
          },
          profile: who === "users" ? { firstName: "Alex" } : undefined,
          capabilities: { help: true, tickets: who === "users" },
          availability: null,
          replyTime: null,
        },
      },
      location.origin,
    );
  }, [
    ready,
    config,
    who,
    scheme,
    shown,
    channel,
    brand.id,
    brand.name,
    workspaceId,
  ]);
  const spacing = config.look.launcherSpacing;
  const launcher = palette(config.color).light;
  const radios = <T extends string>(
    label: string,
    value: T,
    options: readonly (readonly [T, string])[],
    pick: (v: T) => void,
  ) => (
    <span className="pg-settings-buttons" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => pick(v)}
        >
          {text}
        </button>
      ))}
    </span>
  );
  return (
    <aside className="pg-messenger-preview" aria-label="Preview">
      <div className="pg-messenger-preview-head">
        <select
          aria-label="Preview page"
          value={shown}
          onChange={(e) => setView({ ...view, page: e.target.value as Space })}
        >
          {spaces.map((s) => (
            <option key={s} value={s}>
              {SPACE_NAMES[s][0]}
            </option>
          ))}
        </select>
        {radios(
          "Preview audience",
          who,
          [
            ["visitors", "Visitors"],
            ["users", "Users"],
          ] as const,
          (v) => setView({ ...view, who: v }),
        )}
        {radios(
          "Preview theme",
          scheme,
          [
            ["as-set", "As set"],
            ["light", "Light"],
            ["dark", "Dark"],
          ] as const,
          (v) =>
            setView({
              ...view,
              scheme: v,
              colours: v === "as-set" ? view.colours : v,
            }),
        )}
        <small className="pg-muted">
          As {who === "users" ? "a signed-in user (Alex)" : "a visitor"} sees
          the draft.
        </small>
      </div>
      <iframe
        ref={frame}
        title="Messenger preview"
        src={`/messenger/frame.html?preview=1&parent=${encodeURIComponent(location.origin)}&channel=${channel}`}
        sandbox="allow-scripts allow-same-origin"
      />
      <div
        className="pg-launcher-preview"
        aria-label="Launcher preview"
        role="img"
      >
        <span
          data-shape={config.shape}
          style={{
            background: launcher.accent,
            color: onColour(launcher.accent),
            bottom: Math.min(spacing.bottom, 60) / 2 + 6,
            [config.position === "left" ? "left" : "right"]:
              Math.min(spacing.side, 120) / 2 + 6,
          }}
        >
          {imageSource(config.look.launcherLogo) ? (
            <img src={imageSource(config.look.launcherLogo)} alt="" />
          ) : (
            "✦"
          )}
        </span>
      </div>
    </aside>
  );
}
