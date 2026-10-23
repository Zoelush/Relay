import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › Security › Single sign-on (phase 16, step C4a; docs/SECURITY_STEP5.md), for
 * `security.manage`, behind `security_v1`: the OIDC connection (the address to give the identity
 * provider, its issuer, client ID and secret, which is never shown again), turning it on and
 * enforcing it, the email domains it signs in (verified by a DNS TXT record), and which groups get
 * which role (the first match wins; no match, no access). C4b: or SAML 2.0 instead (the provider's
 * SSO URL, entity ID and certificate), with Relay's entity ID, ACS and metadata to give it.
 */
type Sso = {
  redirectUri: string | null;
  serviceProvider: { entityId: string; acsUrl: string; metadataUrl: string } | null;
  connection: {
    protocol: "oidc" | "saml";
    entryPoint: string | null;
    idpCert: string | null;
    name: string;
    issuer: string;
    clientId: string | null;
    hasSecret: boolean;
    groupsClaim: string;
    enabled: boolean;
    enforced: boolean;
    lastSuccessAt: string | null;
    lastError: string | null;
    people: number;
  } | null;
  domains: { domain: string; record: { type: string; name: string; value: string }; verified: boolean; checkedAt: string | null; error: string | null }[];
  mappings: { group: string; roleId: string }[];
  roles: { id: string; name: string }[];
};
/** Built-in roles are stored as owner, admin and agent: shown with a capital, as Settings › Teammates does. */
const roleName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function SsoPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Sso | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ protocol: "oidc" as "oidc" | "saml", name: "", issuer: "", clientId: "", clientSecret: "", groupsClaim: "groups", entryPoint: "", idpIssuer: "", idpCert: "" });
  const [domain, setDomain] = useState("");
  const [mappings, setMappings] = useState<{ group: string; roleId: string }[]>([]);
  const take = (d: Sso) => {
    setData(d);
    setMappings(d.mappings);
    const c = d.connection;
    if (c)
      setForm({
        protocol: c.protocol,
        name: c.name,
        issuer: c.protocol === "oidc" ? c.issuer : "",
        clientId: c.clientId ?? "",
        clientSecret: "",
        groupsClaim: c.groupsClaim,
        entryPoint: c.entryPoint ?? "",
        idpIssuer: c.protocol === "saml" ? c.issuer : "",
        idpCert: c.idpCert ?? "",
      });
  };
  const load = useCallback(
    () =>
      api<Sso>("sso-settings")
        .then(take)
        .catch((e) => setError(message(e, "Single sign-on couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (p: Record<string, unknown>, done: string, fallback: string) => {
    setError("");
    setNotice("");
    try {
      take(await api<Sso>("sso-settings", p));
      setNotice(done);
      return true;
    } catch (e) {
      setError(message(e, fallback));
      return false;
    }
  };
  const c = data?.connection;
  const set = (k: Exclude<keyof typeof form, "protocol">) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const saml = form.protocol === "saml";
  const verified = data?.domains.some((d) => d.verified) ?? false;
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
      {data && (
        <>
          <Card title="Connection" description="Relay signs people in with your identity provider (Okta, Microsoft Entra ID, Google Workspace and others), using OpenID Connect or SAML 2.0.">
            <fieldset className="pg-settings-checks" aria-label="Protocol">
              <label>
                <input type="radio" name="sso-protocol" checked={!saml} onChange={() => setForm({ ...form, protocol: "oidc" })} /> OpenID Connect
              </label>
              <label>
                <input type="radio" name="sso-protocol" checked={saml} onChange={() => setForm({ ...form, protocol: "saml" })} /> SAML 2.0
              </label>
            </fieldset>
            {!saml && data.redirectUri && (
              <p className="pg-muted">
                Give your identity provider this sign-in redirect address: <code aria-label="Redirect address">{data.redirectUri}</code>
              </p>
            )}
            {saml && data.serviceProvider && (
              <dl className="pg-saml-sp" aria-label="Relay as a service provider">
                <dt>Entity ID (audience)</dt>
                <dd>
                  <code>{data.serviceProvider.entityId}</code>
                </dd>
                <dt>Assertion consumer service (HTTP-POST)</dt>
                <dd>
                  <code>{data.serviceProvider.acsUrl}</code>
                </dd>
                <dt>Metadata, to import</dt>
                <dd>
                  <code>{data.serviceProvider.metadataUrl}</code>
                </dd>
              </dl>
            )}
            <form
              className="pg-signin-settings"
              aria-label="Single sign-on connection"
              onSubmit={(e) => {
                e.preventDefault();
                const fields = saml
                  ? { protocol: "saml", name: form.name, entryPoint: form.entryPoint, idpIssuer: form.idpIssuer, idpCert: form.idpCert, groupsClaim: form.groupsClaim }
                  : { protocol: "oidc", name: form.name, issuer: form.issuer, clientId: form.clientId, clientSecret: form.clientSecret, groupsClaim: form.groupsClaim };
                void act({ action: "connection", ...fields }, "Connection saved.", "The connection couldn't be saved.");
              }}
            >
              <label className="pg-settings-field">
                <span className="pg-settings-label">Name people see</span>
                <input value={form.name} maxLength={80} placeholder="Okta" onChange={set("name")} />
              </label>
              {saml ? (
                <>
                  <label className="pg-settings-field">
                    <span className="pg-settings-label">Identity provider’s SSO URL</span>
                    <input type="url" required value={form.entryPoint} placeholder="https://your-company.okta.com/app/…/sso/saml" onChange={set("entryPoint")} />
                  </label>
                  <label className="pg-settings-field">
                    <span className="pg-settings-label">Identity provider’s entity ID</span>
                    <input required value={form.idpIssuer} onChange={set("idpIssuer")} />
                  </label>
                  <label className="pg-settings-field">
                    <span className="pg-settings-label">Signing certificate</span>
                    <textarea required rows={5} spellCheck={false} value={form.idpCert} placeholder="-----BEGIN CERTIFICATE-----" onChange={set("idpCert")} />
                  </label>
                </>
              ) : (
                <>
                  <label className="pg-settings-field">
                    <span className="pg-settings-label">Issuer URL</span>
                    <input type="url" required value={form.issuer} placeholder="https://your-company.okta.com" onChange={set("issuer")} />
                  </label>
                  <label className="pg-settings-field">
                    <span className="pg-settings-label">Client ID</span>
                    <input required value={form.clientId} onChange={set("clientId")} />
                  </label>
                  <label className="pg-settings-field">
                    <span className="pg-settings-label">Client secret</span>
                    <input
                      type="password"
                      autoComplete="off"
                      required={!(c?.hasSecret && c.protocol === "oidc")}
                      value={form.clientSecret}
                      placeholder={c?.hasSecret && c.protocol === "oidc" ? "Saved. Leave empty to keep it." : ""}
                      onChange={set("clientSecret")}
                    />
                  </label>
                </>
              )}
              <label className="pg-settings-field">
                <span className="pg-settings-label">{saml ? "Groups attribute" : "Groups claim"}</span>
                <input value={form.groupsClaim} onChange={set("groupsClaim")} />
              </label>
              <button type="submit" className="pg-primary">
                Save connection
              </button>
            </form>
            {c && (
              <>
                <p className="pg-muted">
                  {c.lastSuccessAt ? `Last signed in someone ${when(c.lastSuccessAt)}. ${c.people} ${c.people === 1 ? "person has" : "people have"} signed in this way.` : "Nobody has signed in this way yet."}
                </p>
                {c.lastError && <p className="pg-attr-error">Last problem: {c.lastError}</p>}
                <label className="pg-settings-check">
                  <input
                    type="checkbox"
                    checked={c.enabled}
                    onChange={(e) => void act({ action: "enabled", on: e.target.checked }, e.target.checked ? "Single sign-on is on." : "Single sign-on is off.", "That couldn't be changed.")}
                  />
                  <span>Offer “Sign in with {c.name || "single sign-on"}” on the sign-in page</span>
                </label>
                <label className="pg-settings-check">
                  <input
                    type="checkbox"
                    checked={c.enforced}
                    disabled={!c.enforced && !(c.enabled && verified && c.lastSuccessAt)}
                    aria-describedby="sso-enforce-hint"
                    onChange={(e) => void act({ action: "enforced", on: e.target.checked }, e.target.checked ? "Single sign-on is now required." : "Single sign-on is no longer required.", "That couldn't be changed.")}
                  />
                  <span>Require single sign-on for everyone but owners</span>
                </label>
                <small id="sso-enforce-hint" className="pg-muted">
                  {c.enforced
                    ? "Passwords, invitations and hosting-platform sign-in are for owners only. Owners' password sign-ins are recorded in the audit log."
                    : "Needs single sign-on turned on, a verified domain, and one successful sign-in. Turning it on signs out everyone else's password sessions."}
                </small>
              </>
            )}
          </Card>
          <Card title="Domains" description="Only people whose email is at a verified domain sign in this way. Add a TXT record to your domain's DNS to verify it.">
            {data.domains.length ? (
              <ul className="pg-settings-list" aria-label="Domains">
                {data.domains.map((d) => (
                  <li key={d.domain}>
                    <span>
                      <strong>
                        {d.domain}
                        <span className="pg-settings-badge">{d.verified ? "Verified" : "Not verified"}</span>
                      </strong>
                      {!d.verified && (
                        <small className="pg-muted">
                          TXT record <code>{d.record.name}</code> with the value <code>{d.record.value}</code>
                        </small>
                      )}
                      {d.error && <small className="pg-attr-error">{d.error}</small>}
                    </span>
                    <span className="pg-settings-buttons">
                      {!d.verified && (
                        <button type="button" onClick={() => void act({ action: "verify-domain", domain: d.domain }, `Checking ${d.domain}…`, "That domain couldn't be checked.")}>
                          Check now
                        </button>
                      )}
                      <button
                        type="button"
                        className="pg-wf-link pg-danger-link"
                        aria-label={`Remove ${d.domain}`}
                        onClick={() => void act({ action: "remove-domain", domain: d.domain }, `${d.domain} removed.`, "That domain couldn't be removed.")}
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pg-muted">No domains yet.</p>
            )}
            <form
              className="pg-invite-form"
              aria-label="Add a domain"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await act({ action: "add-domain", domain }, "Domain added. Add its TXT record, then check it.", "That domain couldn't be added.")) setDomain("");
              }}
            >
              <label>
                Domain
                <input required value={domain} placeholder="example.com" onChange={(e) => setDomain(e.target.value)} />
              </label>
              <button type="submit" className="pg-secondary">
                Add domain
              </button>
            </form>
          </Card>
          {c && (
            <Card title="Groups and roles" description="At every sign-in, the first group here that the person is in decides their role. Someone in none of them can't sign in. Owners are chosen in Relay and never changed by groups.">
              <form
                className="pg-signin-settings"
                aria-label="Groups and roles"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act({ action: "mappings", mappings }, "Groups and roles saved.", "Groups and roles couldn't be saved.");
                }}
              >
                {mappings.map((m, i) => (
                  <div key={i} className="pg-invite-form">
                    <label>
                      Group
                      <input required value={m.group} onChange={(e) => setMappings(mappings.map((x, j) => (j === i ? { ...x, group: e.target.value } : x)))} />
                    </label>
                    <label>
                      Role
                      <select value={m.roleId} onChange={(e) => setMappings(mappings.map((x, j) => (j === i ? { ...x, roleId: e.target.value } : x)))}>
                        {data.roles.map((r) => (
                          <option key={r.id} value={r.id}>
                            {roleName(r.name)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="button" className="pg-wf-link pg-danger-link" aria-label={`Remove group ${m.group || i + 1}`} onClick={() => setMappings(mappings.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </div>
                ))}
                <span className="pg-settings-buttons">
                  <button type="button" className="pg-secondary" onClick={() => setMappings([...mappings, { group: "", roleId: data.roles.find((r) => r.id === "agent")?.id ?? data.roles[0]?.id ?? "" }])}>
                    Add a group
                  </button>
                  <button type="submit" className="pg-primary">
                    Save groups and roles
                  </button>
                </span>
              </form>
            </Card>
          )}
        </>
      )}
    </Frame>
  );
}
