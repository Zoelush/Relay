import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import {
  Card,
  Field,
  Frame,
  message,
  type MenuState,
  type Page,
} from "./settings-ui";
import type { Messenger } from "../server/channel-settings";

/**
 * Settings › Channels (S3b; docs/SETTINGS_STEP5.md): brands, each brand's messenger and the
 * customer portal, for workspace managers. The messenger reads its brand's settings on every
 * boot, so a saved change shows on the next page that opens it. Identity keys are listed, never
 * shown; creating and rotating them stays an operator task until phase 16.
 */
type Brand = {
  id: string;
  name: string;
  conversations: number;
  messenger: Messenger;
  identity: { enforced: boolean; legacyHmac: boolean };
  portalUrl?: string;
};
type Brands = {
  workspaceId: string;
  apiOrigin: string;
  brands: Brand[];
  identityKeys: { kid: string; slot: number; createdAt: string }[];
};
function useBrands() {
  const [data, setData] = useState<Brands | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    () =>
      api<Brands>("brands")
        .then(setData)
        .catch((e) => setError(message(e, "Brands could not be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, setError, load };
}
function Messages({ error, notice }: { error: string; notice: string }) {
  return (
    <>
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
    </>
  );
}

export function BrandsPage({
  menu,
  page,
  onMessenger,
}: {
  menu: MenuState;
  page: Page;
  /** Opens a brand's messenger settings. */
  onMessenger?: (brandId: string) => void;
}) {
  const { data, error, setError, load } = useBrands();
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  async function save(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("brands", body);
      setNotice(done);
      return true;
    } catch (e) {
      setError(message(e, "The brand could not be saved."));
      return false;
    } finally {
      setBusy(false);
      void load();
    }
  }
  return (
    <Frame menu={menu} page={page}>
      <Messages error={error} notice={notice} />
      <Card
        title="Brands"
        description="Each brand has its own messenger, look, websites and portal address. Conversations remember the brand they came from, so brands are renamed rather than deleted."
      >
        <ul className="pg-settings-list" aria-label="Brands">
          {data?.brands.map((b) => (
            <li key={b.id}>
              {renaming?.id === b.id ? (
                <form
                  className="pg-settings-row"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (
                      await save(
                        { id: b.id, name: renaming.name },
                        `Renamed ${b.name} to ${renaming.name.trim()}.`,
                      )
                    )
                      setRenaming(null);
                  }}
                >
                  <input
                    aria-label={`New name for ${b.name}`}
                    value={renaming.name}
                    maxLength={80}
                    required
                    autoFocus
                    onChange={(e) =>
                      setRenaming({ id: b.id, name: e.target.value })
                    }
                  />
                  <span className="pg-settings-buttons">
                    <button
                      type="submit"
                      className="pg-primary"
                      disabled={busy}
                    >
                      Save
                    </button>
                    <button type="button" onClick={() => setRenaming(null)}>
                      Cancel
                    </button>
                  </span>
                </form>
              ) : (
                <>
                  <span>
                    <strong>
                      <span
                        className="pg-settings-swatch"
                        style={{ background: b.messenger.color }}
                        aria-hidden="true"
                      />
                      {b.name}
                      {b.id === "default" && (
                        <span className="pg-settings-badge">Default</span>
                      )}
                    </strong>
                    <small className="pg-muted">
                      {b.messenger.allowedOrigins.length
                        ? b.messenger.allowedOrigins.join(", ")
                        : "No websites yet: its messenger loads nowhere"}{" "}
                      · {b.conversations.toLocaleString()}{" "}
                      {b.conversations === 1 ? "conversation" : "conversations"}
                    </small>
                  </span>
                  <span className="pg-settings-buttons">
                    {onMessenger && (
                      <button
                        type="button"
                        aria-label={`Messenger for ${b.name}`}
                        onClick={() => onMessenger(b.id)}
                      >
                        Messenger
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`Rename ${b.name}`}
                      onClick={() => setRenaming({ id: b.id, name: b.name })}
                    >
                      Rename
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Card
        title="New brand"
        description="A new brand starts with the default look and no websites. Add its websites on its messenger page."
      >
        <form
          className="pg-settings-row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await save({ name }, `Added ${name.trim()}.`)) setName("");
          }}
        >
          <Field label="Brand name">
            {(id) => (
              <input
                id={id}
                value={name}
                maxLength={80}
                required
                placeholder="Acme Outdoors"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <button type="submit" className="pg-primary" disabled={busy}>
            Add brand
          </button>
        </form>
      </Card>
    </Frame>
  );
}

const LANGUAGES = [
  "en",
  "en-GB",
  "fr",
  "de",
  "es",
  "pt",
  "pt-BR",
  "it",
  "nl",
  "ar",
  "tr",
  "pl",
  "sv",
  "zh",
  "ja",
  "ko",
  "hi",
  "sw",
  "yo",
  "ha",
  "ig",
];
const languageName = (tag: string) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
};

export function MessengerPage({
  menu,
  page,
  brandId,
  onBrand,
}: {
  menu: MenuState;
  page: Page;
  /** The brand shown, chosen here or from the Brands page. */
  brandId: string;
  onBrand: (id: string) => void;
}) {
  const { data, error, load } = useBrands();
  // Each load (and each brand) starts the form afresh from what's stored.
  const [loads, setLoads] = useState(0);
  const [savedFor, setSavedFor] = useState("");
  const brand =
    data?.brands.find((b) => b.id === brandId) ?? data?.brands[0] ?? null;
  if (!data || !brand)
    return (
      <Frame menu={menu} page={page}>
        {error && (
          <p role="alert" className="pg-attr-error">
            {error}
          </p>
        )}
      </Frame>
    );
  return (
    <MessengerEditor
      key={brand.id + ":" + loads}
      menu={menu}
      page={page}
      data={data}
      brand={brand}
      justSaved={savedFor === brand.id + ":" + loads}
      onBrand={onBrand}
      onSaved={async () => {
        await load();
        setSavedFor(brand.id + ":" + (loads + 1));
        setLoads(loads + 1);
      }}
    />
  );
}

function MessengerEditor({
  menu,
  page,
  data,
  brand,
  justSaved,
  onBrand,
  onSaved,
}: {
  menu: MenuState;
  page: Page;
  data: Brands;
  brand: Brand;
  justSaved: boolean;
  onBrand: (id: string) => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<Messenger>(brand.messenger);
  const [identity, setIdentity] = useState(brand.identity);
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const dirty =
    !!brand &&
    !!form &&
    !!identity &&
    (JSON.stringify(form) !== JSON.stringify(brand.messenger) ||
      JSON.stringify(identity) !== JSON.stringify(brand.identity));
  async function save() {
    if (!brand || !form || !identity) return;
    setBusy(true);
    setError("");
    try {
      if (JSON.stringify(form) !== JSON.stringify(brand.messenger))
        await api("brands", {
          id: brand.id,
          section: "messenger",
          messenger: form,
        });
      if (JSON.stringify(identity) !== JSON.stringify(brand.identity))
        await api("brands", {
          id: brand.id,
          section: "identity",
          enforced: identity.enforced,
          legacyHmac: identity.legacyHmac,
        });
      await onSaved();
    } catch (e) {
      setError(message(e, "The messenger could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  const set = <K extends keyof Messenger>(k: K, v: Messenger[K]) =>
    setForm({ ...form, [k]: v });
  function addWebsite() {
    const w = website.trim().replace(/\/$/, "");
    if (!w || !form) return;
    if (!form.allowedOrigins.includes(w))
      set("allowedOrigins", [...form.allowedOrigins, w]);
    setWebsite("");
  }
  const snippet = `<!-- support-boot.js, served from your own site -->
window.Relay = window.Relay || function () {
  (window.Relay.q = window.Relay.q || []).push(arguments);
};
Relay('boot', {
  api: '${data.apiOrigin}',
  workspaceId: '${data.workspaceId}',
  brandId: '${brand.id}',
  locale: document.documentElement.lang,
});

<!-- In each page, before </body> -->
<script src="/support-boot.js" defer></script>
<script src="${data.apiOrigin}/messenger/loader.js" async></script>`;
  return (
    <Frame
      menu={menu}
      page={page}
      save={{
        dirty,
        busy,
        saved: justSaved,
        error,
        onSave: () => void save(),
      }}
    >
      {data && data.brands.length > 1 && (
        <Field label="Brand" hint="Each brand has its own messenger.">
          {(id, hint) => (
            <select
              id={id}
              aria-describedby={hint}
              value={brand?.id ?? ""}
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
      {
        <>
          <Card
            title="Appearance"
            description="How the launcher and messenger look on your websites."
          >
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
                      pattern="#[0-9a-fA-F]{6}"
                      onChange={(e) => set("color", e.target.value)}
                    />
                  </span>
                )}
              </Field>
              <div
                className="pg-settings-preview"
                data-position={form.position}
                aria-label="Launcher preview"
                role="img"
              >
                <span
                  data-shape={form.shape}
                  style={{ background: form.color }}
                />
              </div>
            </div>
            {(
              [
                [
                  "theme",
                  "Messenger theme",
                  [
                    ["auto", "Follow the visitor's device"],
                    ["light", "Light"],
                    ["dark", "Dark"],
                  ],
                ],
                [
                  "position",
                  "Launcher side",
                  [
                    ["right", "Bottom right"],
                    ["left", "Bottom left"],
                  ],
                ],
                [
                  "shape",
                  "Launcher shape",
                  [
                    ["rounded", "Rounded square"],
                    ["circle", "Circle"],
                  ],
                ],
              ] as const
            ).map(([key, legend, options]) => (
              <fieldset key={key} className="pg-settings-fieldset">
                <legend>{legend}</legend>
                <div className="pg-settings-checks">
                  {options.map(([value, label]) => (
                    <label key={value}>
                      <input
                        type="radio"
                        name={key}
                        checked={form[key] === value}
                        onChange={() => set(key, value as never)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
            <Field
              label="Logo"
              hint="An https:// image address, shown at the top of the messenger. Leave blank for none."
            >
              {(id, hint) => (
                <input
                  id={id}
                  aria-describedby={hint}
                  value={form.logo}
                  maxLength={500}
                  placeholder="https://example.com/logo.png"
                  onChange={(e) => set("logo", e.target.value)}
                />
              )}
            </Field>
          </Card>
          <Card
            title="Greeting"
            description="What visitors read when they open the messenger."
          >
            <Field label="Greeting" hint="Up to 200 characters.">
              {(id, hint) => (
                <input
                  id={id}
                  aria-describedby={hint}
                  value={form.teamIntroduction}
                  maxLength={200}
                  onChange={(e) => set("teamIntroduction", e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Away message"
              hint="Shown outside office hours (Settings › Office hours)."
            >
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
              hint="Used when the website doesn't say which language a visitor reads."
            >
              {(id, hint) => (
                <select
                  id={id}
                  aria-describedby={hint}
                  value={form.locale}
                  onChange={(e) => set("locale", e.target.value)}
                >
                  {[
                    ...new Set([
                      ...(LANGUAGES.includes(form.locale) ? [] : [form.locale]),
                      ...LANGUAGES,
                    ]),
                  ].map((l) => (
                    <option key={l} value={l}>
                      {languageName(l)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </Card>
          <Card
            title="Conversations"
            description="Who can start a conversation, and how."
          >
            {(
              [
                [
                  "allowVisitors",
                  "Visitors can start conversations",
                  "Off: only signed-in, verified customers can.",
                ],
                [
                  "requireSearch",
                  "Ask visitors to search help first",
                  "They search your help center before they can write to you.",
                ],
                [
                  "directConversation",
                  "Open straight to a new conversation",
                  "Skip the home screen when the messenger opens.",
                ],
              ] as const
            ).map(([key, label, help]) => (
              <label key={key} className="pg-settings-toggle">
                <input
                  type="checkbox"
                  checked={form[key]}
                  onChange={(e) => set(key, e.target.checked)}
                />
                <span>
                  <strong>{label}</strong>
                  <small className="pg-muted">{help}</small>
                </span>
              </label>
            ))}
          </Card>
          <Card
            title="Websites"
            description="The messenger loads only on these exact addresses, such as https://shop.example.com. Each subdomain is listed on its own; wildcards aren't allowed."
          >
            {!form.allowedOrigins.length && (
              <p className="pg-muted">
                No websites yet: the messenger won&apos;t load anywhere.
              </p>
            )}
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
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addWebsite();
                  }
                }}
              />
              <button type="button" onClick={addWebsite}>
                Add website
              </button>
            </div>
          </Card>
          <Card
            title="Identity verification"
            description="Your server signs each signed-in customer's identity, so nobody can read another customer's conversations by claiming their email."
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
                <small className="pg-muted">
                  Recommended. Off: an unsigned customer is treated as a
                  visitor. They still can&apos;t read an existing
                  customer&apos;s history.
                </small>
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
                <small className="pg-muted">
                  Only for integrations that can&apos;t sign a JWT yet.
                </small>
              </span>
            </label>
            <div>
              <strong className="pg-settings-small">Signing keys</strong>
              {data.identityKeys.length ? (
                <ul className="pg-settings-list" aria-label="Signing keys">
                  {data.identityKeys.map((k) => (
                    <li key={k.kid}>
                      <span>
                        <strong>{k.kid}</strong>
                        <small className="pg-muted">
                          Slot {k.slot} · added{" "}
                          {new Date(k.createdAt).toLocaleDateString()}
                        </small>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="pg-attr-error">
                  No signing key: verified identities can&apos;t work until your
                  operator installs one.
                </p>
              )}
              <p className="pg-muted pg-settings-small">
                Keys are shared by every brand. Your operator installs and
                rotates them (docs/MESSENGER.md); their secrets are never shown
                here.
              </p>
            </div>
          </Card>
          <Card
            title="Install"
            description="Add these to every page of the websites above. The boot file lives on your site, so your pages need no inline scripts."
          >
            <pre className="pg-settings-code" aria-label="Install snippet">
              {snippet}
            </pre>
            <div>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(snippet)
                    .then(() => setCopied(true))
                    .catch(() => undefined);
                }}
              >
                {copied ? "Copied" : "Copy snippet"}
              </button>
            </div>
          </Card>
        </>
      }
    </Frame>
  );
}

type PortalSettings = {
  visibility: "individual" | "company";
  notice?: string;
  domains: { host: string; brandId: string }[];
};
export function PortalPage({ menu, page }: { menu: MenuState; page: Page }) {
  const { data: brands } = useBrands();
  const [portal, setPortal] = useState<PortalSettings | null>(null);
  const [host, setHost] = useState("");
  const [hostBrand, setHostBrand] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api<PortalSettings>("portal-settings")
        .then(setPortal)
        .catch((e) => setError(message(e, "The portal could not be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function change(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setPortal(await api<PortalSettings>("portal-settings", body));
      setNotice(done);
      return true;
    } catch (e) {
      setError(message(e, "The portal could not be saved."));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const brandName = (id: string) =>
    brands?.brands.find((b) => b.id === id)?.name ?? id;
  return (
    <Frame menu={menu} page={page}>
      <Messages error={error} notice={notice} />
      {portal && (
        <>
          <Card
            title="Who sees which requests"
            description="Customers sign in to the portal to follow their requests and tickets."
          >
            {(
              [
                [
                  "individual",
                  "Only their own",
                  "Each customer sees the requests they raised.",
                ],
                [
                  "company",
                  "Everyone at their company",
                  "Customers see their company's requests too.",
                ],
              ] as const
            ).map(([value, label, help]) => (
              <label key={value} className="pg-settings-toggle">
                <input
                  type="radio"
                  name="portal-visibility"
                  checked={portal.visibility === value}
                  disabled={busy}
                  onChange={() =>
                    void change(
                      { op: "visibility", visibility: value },
                      `Customers now see ${value === "company" ? "their company's requests" : "only their own requests"}.`,
                    )
                  }
                />
                <span>
                  <strong>{label}</strong>
                  <small className="pg-muted">{help}</small>
                </span>
              </label>
            ))}
            {portal.notice && (
              <p className="pg-muted pg-settings-small">{portal.notice}</p>
            )}
            <p className="pg-muted pg-settings-small">
              Each ticket type can override this in Settings › Ticket types.
            </p>
          </Card>
          <Card
            title="Portal addresses"
            description="Every brand has a portal address. Link to it from your site, or give it a domain of your own below."
          >
            <ul className="pg-settings-list" aria-label="Portal addresses">
              {brands?.brands.map((b) => (
                <li key={b.id}>
                  <span>
                    <strong>{b.name}</strong>
                    <small className="pg-muted">
                      {b.portalUrl ?? "Portal off"}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          <Card
            title="Custom domains"
            description="Serve a brand's portal from your own host name, such as help.example.com. Point the host at Relay with your DNS provider first."
          >
            {!portal.domains.length && (
              <p className="pg-muted">No custom domains yet.</p>
            )}
            <ul className="pg-settings-list" aria-label="Custom domains">
              {portal.domains.map((d) => (
                <li key={d.host}>
                  <span>
                    <strong>{d.host}</strong>
                    <small className="pg-muted">{brandName(d.brandId)}</small>
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Remove ${d.host}`}
                    onClick={() =>
                      void change(
                        { op: "remove_domain", host: d.host },
                        `Removed ${d.host}.`,
                      )
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="pg-settings-row"
              onSubmit={async (e) => {
                e.preventDefault();
                const brandId = hostBrand || brands?.brands[0]?.id || "";
                if (
                  await change(
                    { op: "add_domain", host: host.trim(), brandId },
                    `Added ${host.trim().toLowerCase()} for ${brandName(brandId)}.`,
                  )
                )
                  setHost("");
              }}
            >
              <Field label="Host name">
                {(id) => (
                  <input
                    id={id}
                    value={host}
                    required
                    placeholder="help.example.com"
                    onChange={(e) => setHost(e.target.value)}
                  />
                )}
              </Field>
              {(brands?.brands.length ?? 0) > 1 && (
                <Field label="For brand">
                  {(id) => (
                    <select
                      id={id}
                      value={hostBrand || brands?.brands[0]?.id}
                      onChange={(e) => setHostBrand(e.target.value)}
                    >
                      {brands?.brands.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              )}
              <button type="submit" className="pg-primary" disabled={busy}>
                Add domain
              </button>
            </form>
          </Card>
        </>
      )}
    </Frame>
  );
}
