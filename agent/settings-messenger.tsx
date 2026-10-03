import { useEffect, useState } from "react";
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
  snippetFor,
  type Brand,
  type Brands,
} from "./settings-channels";
import type {
  AudienceConfig,
  HomeCard,
  MessengerConfig,
  Space,
} from "../server/messenger-config";

/**
 * Settings › Messenger with drafts (messenger settings M1; docs/MESSENGER_SETTINGS_STEP1.md).
 * Everything the customer sees is edited as a draft: Save keeps it, Publish puts it live as a new
 * version, Discard goes back to what's live, and an earlier version can be restored into the
 * draft. Visitors and signed-in users each get their own spaces, opening, launcher and start
 * button; Home cards say who sees them. Identity verification is a security setting, saved at
 * once rather than drafted.
 */
export type DraftState = {
  brandId: string;
  draft: MessengerConfig;
  draftVersion: string;
  live: MessengerConfig;
  liveVersion: number | null;
  changed: boolean;
  versions: {
    version: number;
    publishedAt: string;
    publishedBy: string | null;
  }[];
};

/** The draft for a brand: undefined while loading, null when drafts are off for the workspace. */
export function useMessengerDrafts(brandId: string | null) {
  const [state, setState] = useState<DraftState | null | undefined>(undefined);
  // Kept here, so it survives the editor starting afresh from each saved draft.
  const [notice, setNotice] = useState("");
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
  return { state, setState, notice, setNotice };
}

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
const cardName = (t: HomeCard["type"]) =>
  CARDS.find(([v]) => v === t)?.[1] ?? t;
const when = (iso: string) => new Date(iso).toLocaleString();

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
}) {
  const [form, setForm] = useState<MessengerConfig>(state.draft);
  const [who, setWho] = useState<"visitors" | "users">("visitors");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [website, setWebsite] = useState("");
  const [newCard, setNewCard] = useState<HomeCard["type"]>("link");
  const [newLanguage, setNewLanguage] = useState("");
  const [restore, setRestore] = useState("");
  const dirty = JSON.stringify(form) !== JSON.stringify(state.draft);
  const aud = form.audiences[who];
  const set = <K extends keyof MessengerConfig>(k: K, v: MessengerConfig[K]) =>
    setForm({ ...form, [k]: v });
  const setAud = (change: Partial<AudienceConfig>) =>
    set("audiences", { ...form.audiences, [who]: { ...aud, ...change } });
  const languages = Object.keys(form.welcome);

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
            "Draft saved. Publish to put it live.",
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
          Publish
        </button>
      }
    >
      {notice && (
        <p role="status" className="pg-settings-notice">
          {notice}
        </p>
      )}
      <Card
        title="Publishing"
        description="Changes are a draft until you publish them. Published versions are kept, so you can go back to one."
      >
        <p className="pg-settings-small" data-testid="publish-state">
          {dirty
            ? "Unsaved changes."
            : state.changed
              ? "Draft saved, not published yet."
              : state.liveVersion
                ? `Live: version ${state.liveVersion}, as published.`
                : "Live: the messenger as it was set up before drafts. Publish to make version 1."}
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
                    `Version ${restore} restored into the draft. Publish to put it live.`,
                  )
                }
              >
                Restore into draft
              </button>
            </>
          )}
        </div>
      </Card>
      {data.brands.length > 1 && (
        <Field label="Brand" hint="Each brand has its own messenger.">
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
      )}

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
            onClick={() => setWho(value)}
          >
            {label}
          </button>
        ))}
        <small className="pg-muted">
          {AUDIENCES.find(([v]) => v === who)![2]} Spaces, Opening and Start
          button below are for {who === "visitors" ? "visitors" : "users"}.
        </small>
      </div>

      <Card
        title="Spaces"
        description="The tabs along the bottom of the messenger, in order."
      >
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
      </Card>

      <Card
        title="Opening"
        description="What happens when the messenger opens, and where the launcher shows."
      >
        <label className="pg-settings-toggle">
          <input
            type="checkbox"
            checked={aud.launchToConversation}
            onChange={(e) => setAud({ launchToConversation: e.target.checked })}
          />
          <span>
            <strong>Open straight into a conversation</strong>
            <small className="pg-muted">
              Skip Home: a new message, or their most recent conversation.
            </small>
          </span>
        </label>
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
              <option value="always">On every page</option>
              <option value="only_matching">Only on pages that match</option>
              <option value="except_matching">
                On every page except those that match
              </option>
              <option value="never">Never</option>
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
      </Card>

      <Card
        title="Start button"
        description="The wording of the button that starts a conversation."
      >
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
      </Card>

      <Card
        title="Home cards"
        description="The cards under the welcome on Home, in order. Each card says who sees it."
      >
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
      </Card>

      <Card
        title="Welcome"
        description="The greeting and introduction at the top of Home, in each language. {first_name} becomes a signed-in customer's first name, and is left out for visitors."
      >
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
      </Card>

      <Card
        title="Special notice"
        description="A short notice at the top of Home and Messages for everyone, such as a delay or an outage."
      >
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
      </Card>

      <Card title="Look" description="Colour, theme, launcher and logo.">
        <div className="pg-settings-row">
          <Field label="Brand colour">
            {(id) => (
              <span className="pg-settings-colour">
                <input
                  type="color"
                  aria-label="Pick the brand colour"
                  value={form.color}
                  onChange={(e) => set("color", e.target.value)}
                />
                <input
                  id={id}
                  value={form.color}
                  maxLength={7}
                  onChange={(e) => set("color", e.target.value)}
                />
              </span>
            )}
          </Field>
          <Field label="Messenger theme">
            {(id) => (
              <select
                id={id}
                value={form.theme}
                onChange={(e) =>
                  set("theme", e.target.value as typeof form.theme)
                }
              >
                <option value="auto">Follow the visitor&apos;s device</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            )}
          </Field>
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
        <Field
          label="Logo"
          hint="An https:// image address, shown at the top of the messenger."
        >
          {(id, hint) => (
            <input
              id={id}
              aria-describedby={hint}
              maxLength={500}
              value={form.logo}
              placeholder="https://example.com/logo.png"
              onChange={(e) => set("logo", e.target.value)}
            />
          )}
        </Field>
      </Card>

      <Card
        title="Conversations"
        description="Who can start one, and what they read."
      >
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
        </Field>
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
      </Card>

      <Card
        title="Websites"
        description="The messenger loads only on these exact addresses, such as https://shop.example.com. Each subdomain is listed on its own; wildcards aren't allowed."
      >
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
      </Card>

      <IdentityCard data={data} brand={brand} onSaved={onIdentity} />

      <Card
        title="Install"
        description="Add these to every page of the websites above."
      >
        <pre className="pg-settings-code" aria-label="Install snippet">
          {snippetFor(data.apiOrigin, data.workspaceId, brand.id)}
        </pre>
      </Card>
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
