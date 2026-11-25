import { useEffect, useState } from "react";
import { api } from "./api";

/** A customer's company, as the conversation context gives it (phase 01 P1b). */
export type CustomerCompany = {
  id: string;
  companyId: string;
  name: string;
  plan: string | null;
  seats: number | null;
  monthlySpend: string | null;
  website: string | null;
  customAttributes: Record<string, string | number | boolean>;
  people: number;
  role: string;
  source: "api" | "inbox" | "messenger" | "merge";
};
type Found = {
  id: string;
  company_id: string;
  name: string;
  plan: string | null;
  contact_count: number;
};
type Membership = {
  id: string;
  company_id: string;
  name: string;
  plan: string | null;
  seats: number | null;
  monthly_spend: number | null;
  website: string | null;
  custom_attributes: Record<string, string | number | boolean>;
  contact_count: number;
  role: string;
  source: CustomerCompany["source"];
};

const asCompany = (m: Membership): CustomerCompany => ({
  id: m.id,
  companyId: m.company_id,
  name: m.name,
  plan: m.plan,
  seats: m.seats,
  monthlySpend: m.monthly_spend === null ? null : String(m.monthly_spend),
  website: m.website,
  customAttributes: m.custom_attributes,
  people: m.contact_count,
  role: m.role,
  source: m.source,
});
const SOURCE: Record<CustomerCompany["source"], string> = {
  api: "Added through the API",
  inbox: "Added by a teammate",
  messenger: "Set by their signed-in messenger",
  merge: "Came with a merged contact",
};
const money = (v: string) =>
  Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });

/**
 * The Companies part of the details sidebar: the customer's companies with their plan, seats,
 * monthly spend, custom data and the customer's role in each; a teammate who may see personal data
 * adds them to a company (found by name, or made new), changes their role there, or takes them out.
 */
export function CustomerCompanies({
  contactId,
  customerName,
  companies: initial,
  onError,
}: {
  contactId: string;
  customerName: string;
  companies: CustomerCompany[];
  onError: (e: unknown) => void;
}) {
  const [companies, setCompanies] = useState(initial);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [role, setRole] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!adding) return;
    let live = true;
    const t = setTimeout(() => {
      api<{ companies: Found[] }>(
        "companies?" + new URLSearchParams({ q: query }),
      )
        .then((d) => live && setFound(d.companies))
        .catch((e) => live && onError(e));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [adding, query, onError]);

  const change = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ companies: Membership[] }>("companies", {
        contactId,
        ...body,
      });
      setCompanies(r.companies.map(asCompany));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That couldn't be saved.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const join = async (body: Record<string, unknown>) => {
    if (
      await change({
        action: "attach",
        role: role.trim() || undefined,
        ...body,
      })
    ) {
      setAdding(false);
      setQuery("");
      setRole("");
    }
  };
  const mine = new Set(companies.map((c) => c.id));
  const choices = found.filter((f) => !mine.has(f.id));
  const exact = found.some(
    (f) => f.name.toLowerCase() === query.trim().toLowerCase(),
  );
  const who = customerName || "this customer";

  return (
    <section aria-labelledby="ctx-companies" className="pg-ctx-companies">
      <h3 id="ctx-companies">Companies</h3>
      {companies.length ? (
        <ul className="pg-company-list">
          {companies.map((c) => (
            <li key={c.id} className="pg-company">
              <div className="pg-company-head">
                <span className="pg-company-mark" aria-hidden="true">
                  {c.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="pg-company-title">
                  <strong>{c.name}</strong>
                  <small>
                    {[
                      c.plan,
                      c.seats !== null
                        ? `${c.seats} seat${c.seats === 1 ? "" : "s"}`
                        : null,
                      c.monthlySpend !== null
                        ? `${money(c.monthlySpend)} a month`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") ||
                      `${c.people} ${c.people === 1 ? "person" : "people"}`}
                  </small>
                </div>
              </div>
              {editing === c.id ? (
                <form
                  className="pg-company-role-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (
                      await change({
                        action: "role",
                        companyId: c.id,
                        role: roleDraft,
                      })
                    )
                      setEditing(null);
                  }}
                >
                  <label htmlFor={"role-" + c.id}>Role at {c.name}</label>
                  <input
                    id={"role-" + c.id}
                    value={roleDraft}
                    maxLength={100}
                    onChange={(e) => setRoleDraft(e.target.value)}
                    autoFocus
                  />
                  <div className="pg-company-actions">
                    <button type="submit" disabled={busy}>
                      Save
                    </button>
                    <button
                      type="button"
                      className="pg-link-button"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <dl>
                  <div className="pg-ctx-row">
                    <dt>Role</dt>
                    <dd>
                      {c.role || (
                        <span className="pg-muted-text">None given</span>
                      )}
                    </dd>
                  </div>
                  {Object.entries(c.customAttributes).map(([name, value]) => (
                    <div key={name} className="pg-ctx-row">
                      <dt>{name}</dt>
                      <dd>
                        {value === true
                          ? "Yes"
                          : value === false
                            ? "No"
                            : String(value)}
                      </dd>
                    </div>
                  ))}
                  {c.website && (
                    <div className="pg-ctx-row">
                      <dt>Website</dt>
                      <dd>{c.website}</dd>
                    </div>
                  )}
                  <div className="pg-ctx-row">
                    <dt>People</dt>
                    <dd>{c.people}</dd>
                  </div>
                </dl>
              )}
              <div className="pg-company-foot">
                <small title={SOURCE[c.source]}>{SOURCE[c.source]}</small>
                {editing !== c.id && (
                  <span className="pg-company-actions">
                    <button
                      type="button"
                      className="pg-link-button"
                      aria-label={`Change ${who}'s role at ${c.name}`}
                      onClick={() => {
                        setEditing(c.id);
                        setRoleDraft(c.role);
                      }}
                    >
                      Role
                    </button>
                    <button
                      type="button"
                      className="pg-link-button"
                      aria-label={`Remove ${who} from ${c.name}`}
                      disabled={busy}
                      onClick={() =>
                        void change({ action: "detach", companyId: c.id })
                      }
                    >
                      Remove
                    </button>
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pg-empty">Not in any company.</p>
      )}
      {adding ? (
        <div className="pg-company-add">
          <label htmlFor="company-search">Company</label>
          <input
            id="company-search"
            value={query}
            maxLength={255}
            placeholder="Search or name a new one"
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <label htmlFor="company-role">Their role (optional)</label>
          <input
            id="company-role"
            value={role}
            maxLength={100}
            onChange={(e) => setRole(e.target.value)}
          />
          <ul className="pg-company-choices" aria-label="Companies found">
            {choices.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void join({ companyId: f.id })}
                >
                  <span>{f.name}</span>
                  <small>
                    {[
                      f.plan,
                      `${f.contact_count} ${f.contact_count === 1 ? "person" : "people"}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </button>
              </li>
            ))}
            {query.trim() && !exact && (
              <li>
                <button
                  type="button"
                  className="pg-company-new"
                  disabled={busy}
                  onClick={() => void join({ name: query.trim() })}
                >
                  Create “{query.trim()}”
                </button>
              </li>
            )}
          </ul>
          <button
            type="button"
            className="pg-link-button"
            onClick={() => setAdding(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="pg-link-button"
          onClick={() => setAdding(true)}
        >
          Add to a company
        </button>
      )}
      {error && (
        <p className="pg-attr-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
