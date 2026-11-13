import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Field, Frame, message, type MenuState, type Page } from "./settings-ui";
import { money, STATUS_WORDS, unitPrice, type InvoiceStatus, type LineKind } from "../lib/invoices";

/**
 * Settings › Billing › Invoices (phase 16, step C10a; docs/SECURITY_STEP20.md), for
 * `billing.manage`: the billing details an invoice is addressed to, the card on file, the invoice
 * this period is building towards, and every invoice issued — each one openable line by line, with
 * what each line counts, and downloadable as a PDF.
 *
 * Amounts are the server's. An invoice whose prices aren't set yet is issued "Not priced yet": it
 * shows what it counted and is never charged.
 */
type Invoice = {
  id: string;
  number: string;
  period: { start: string; end: string };
  plan: string;
  status: InvoiceStatus;
  currency: string;
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  issuedAt: string;
  paidAt: string | null;
  failure: string;
  dunning: "none" | "retrying" | "unpaid";
  nextAttemptAt: string | null;
};
type Line = {
  id: string;
  kind: LineKind;
  meter: string | null;
  description: string;
  quantity: number;
  unitCents: number | null;
  amountCents: number | null;
  units: number;
};
type Billing = {
  profile: Record<string, string>;
  card: { brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null } | null;
  payments: "stripe" | "stand-in" | null;
  /** C10c: set while an invoice has gone unpaid and automated sending is paused. */
  paused: string | null;
  upcoming: {
    period: { start: string; end: string };
    priced: boolean;
    totalCents: number | null;
    lines: { kind: LineKind; description: string; quantity: number; unitCents: number | null; amountCents: number | null }[];
  };
  invoices: Invoice[];
};
type Unit = { id: string; at: string; quantity: number; conversationId: string | null; contactId: string | null; detail: string };

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const quantity = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));
/** The fields of the address an invoice is made out to. */
const PROFILE: { key: string; label: string; hint?: string }[] = [
  { key: "email", label: "Billing email", hint: "Where invoices are sent." },
  { key: "name", label: "Billed to" },
  { key: "addressLine1", label: "Address" },
  { key: "addressLine2", label: "Address line 2" },
  { key: "city", label: "City" },
  { key: "postalCode", label: "Postcode" },
  { key: "country", label: "Country", hint: "Two letters, such as GB or US." },
  { key: "taxId", label: "Tax ID", hint: "Shown on the invoice (VAT number, for example)." },
];

/** A line's frozen units: what it counted, 50 at a time. */
function Units({ line }: { line: Line }) {
  const [units, setUnits] = useState<Unit[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    (cursor: string | null) =>
      api<{ units: Unit[]; next: string | null }>(`invoice-units?line=${encodeURIComponent(line.id)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
        .then((r) => {
          setUnits((u) => (cursor ? [...u, ...r.units] : r.units));
          setNext(r.next);
        })
        .catch((e) => setError(message(e, "What this line counts couldn't be loaded."))),
    [line.id],
  );
  useEffect(() => {
    void load(null);
  }, [load]);
  return (
    <>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {units.length > 0 && (
        <ul className="pg-settings-list" aria-label={`What ${line.description} counts`}>
          {units.map((u) => (
            <li key={u.id}>
              <span>
                {time(u.at)} · {quantity(u.quantity)}
                {u.detail ? <small className="pg-muted"> · {u.detail}</small> : null}
              </span>
              {u.conversationId ? (
                <a className="pg-wf-link" href={`#conversation/${u.conversationId}`}>
                  Open conversation
                </a>
              ) : u.contactId ? (
                <small className="pg-muted">Contact {u.contactId.slice(0, 8)}</small>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {next && (
        <button type="button" className="pg-secondary" onClick={() => void load(next)}>
          Show more
        </button>
      )}
    </>
  );
}

/** One issued invoice, line by line. */
function InvoiceDetail({ id, currency }: { id: string; currency: string }) {
  const [data, setData] = useState<{ invoice: Invoice; lines: Line[]; billTo: Record<string, string> } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ invoice: Invoice; lines: Line[]; billTo: Record<string, string> }>("invoice?id=" + encodeURIComponent(id))
      .then(setData)
      .catch((e) => setError(message(e, "That invoice couldn't be loaded.")));
  }, [id]);
  if (error)
    return (
      <p role="alert" className="pg-attr-error">
        {error}
      </p>
    );
  if (!data) return <p className="pg-muted">Loading…</p>;
  return (
    <div className="pg-invoice-detail">
      <div className="pg-trust-scroll">
        <table className="pg-trust-table" aria-label={`Invoice ${data.invoice.number}`}>
          <thead>
            <tr>
              <th scope="col">Line</th>
              <th scope="col">Quantity</th>
              <th scope="col">Each</th>
              <th scope="col">Amount</th>
              <th scope="col">
                <span className="pg-visually-hidden">What it counts</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.description}</td>
                <td>{quantity(l.quantity)}</td>
                <td>{unitPrice(l.unitCents)}</td>
                <td>{money(l.amountCents, currency)}</td>
                <td>
                  {l.units > 0 && (
                    <button type="button" className="pg-secondary" aria-expanded={open === l.id} onClick={() => setOpen((o) => (o === l.id ? null : l.id))}>
                      {open === l.id ? "Hide" : `What it counts (${l.units})`}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            <tr>
              <th scope="row" colSpan={3}>
                Total
              </th>
              <td>{money(data.invoice.totalCents, currency)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      {open && <Units line={data.lines.find((l) => l.id === open)!} />}
      <p className="pg-muted">
        Every line is frozen with what it counts, so it can be checked unit by unit. Billed to{" "}
        {data.billTo.name || data.billTo.email || "this workspace"}.
      </p>
    </div>
  );
}

export function InvoicesPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Billing | null>(null);
  const [profile, setProfile] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const take = (b: Billing) => {
    setData(b);
    setProfile(b.profile);
  };
  const load = useCallback(
    () =>
      api<Billing>("invoices")
        .then(take)
        .catch((e) => setError(message(e, "Billing couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
    // Back from the provider's page with a finished setup session: keep the card.
    const session = new URLSearchParams(window.location.search).get("billing_setup");
    if (!session) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("billing_setup");
    window.history.replaceState(null, "", url.toString());
    api<Billing>("invoices", { action: "card_done", session })
      .then((b) => {
        take(b);
        setNotice("Your card is saved.");
      })
      .catch((e) => setError(message(e, "The card wasn't saved. Try again.")));
  }, [load]);
  const dirty = data ? PROFILE.some((f) => (profile[f.key] ?? "") !== (data.profile[f.key] ?? "")) : false;
  const run = async (what: string, body: Record<string, unknown>, done: string) => {
    setBusy(what);
    setError("");
    setNotice("");
    try {
      const r = await api<Billing | { url: string } | { jobId: string }>("invoices", body);
      if ("url" in r) {
        // The provider's own page: card numbers never reach Relay.
        window.location.href = r.url;
        return;
      }
      if ("jobId" in r) {
        setNotice(done);
        // The charge runs as a job; the page catches up with it.
        setTimeout(() => void load(), 1500);
      } else {
        take(r);
        setNotice(done);
      }
    } catch (e) {
      setError(message(e, "That didn't work."));
    } finally {
      setBusy("");
    }
  };
  return (
    <Frame
      menu={menu}
      page={page}
      save={{
        dirty,
        busy: busy === "profile",
        saved: notice === "Billing details saved.",
        error: "",
        onSave: () => void run("profile", { action: "profile", ...profile }, "Billing details saved."),
        label: "Save details",
      }}
    >
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
      {data?.paused && (
        <p role="alert" className="pg-attr-error">
          {data.paused} Automated sending is paused — Zoe&apos;s replies, outbound messages and automated emails and
          texts. Your team&apos;s own replies and calls still work. Paying lifts it at once.
        </p>
      )}
      {data && (
        <>
          <Card
            title="Payment method"
            description="Your card is kept by the payment provider, not by Relay. Relay keeps only its brand, last four digits and expiry."
          >
            {data.card ? (
              <p className="pg-settings-value">
                {(data.card.brand ?? "Card").toUpperCase()} ending {data.card.last4} · expires{" "}
                {String(data.card.expMonth).padStart(2, "0")}/{data.card.expYear}
              </p>
            ) : (
              <p className="pg-muted">No card on file. Invoices stay due until one is added.</p>
            )}
            {data.payments ? (
              <button type="button" className="pg-secondary" disabled={busy === "card"} onClick={() => void run("card", { action: "card" }, "")}>
                {data.card ? "Replace card" : "Add a card"}
              </button>
            ) : (
              <p className="pg-muted">Payments aren&apos;t set up in this deployment.</p>
            )}
          </Card>

          <Card title="Billing details" description="What each invoice is made out to.">
            {PROFILE.map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint}>
                {(id, hintId) => (
                  <input
                    id={id}
                    aria-describedby={hintId}
                    value={profile[f.key] ?? ""}
                    maxLength={f.key === "country" ? 2 : 254}
                    onChange={(e) => setProfile((p) => ({ ...p, [f.key]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
          </Card>

          <Card
            title="This period"
            description={`What the invoice for ${day(data.upcoming.period.start)} to ${day(data.upcoming.period.end)} is building towards. It is issued when the period starts.`}
          >
            <div className="pg-trust-scroll">
              <table className="pg-trust-table" aria-label="The upcoming invoice">
                <thead>
                  <tr>
                    <th scope="col">Line</th>
                    <th scope="col">Quantity</th>
                    <th scope="col">Each</th>
                    <th scope="col">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.upcoming.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.description}</td>
                      <td>{quantity(l.quantity)}</td>
                      <td>{unitPrice(l.unitCents)}</td>
                      <td>{money(l.amountCents)}</td>
                    </tr>
                  ))}
                  <tr>
                    <th scope="row" colSpan={3}>
                      Total
                    </th>
                    <td>{money(data.upcoming.totalCents)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {!data.upcoming.priced && (
              <p className="pg-muted">
                Prices aren&apos;t set yet, so this invoice will be issued unpriced: it records what it counted and is never charged.
              </p>
            )}
          </Card>

          <Card title="Invoices" description="Every invoice issued, newest first. Each one can be checked line by line.">
            {data.invoices.length === 0 ? (
              <p className="pg-muted">No invoices yet. The first is issued when this period ends.</p>
            ) : (
              <ul className="pg-settings-list" aria-label="Invoices">
                {data.invoices.map((inv) => (
                  <li key={inv.id} className="pg-invoice-row">
                    <span>
                      <strong>{inv.number}</strong>
                      <small className="pg-muted">
                        {" "}
                        {day(inv.period.start)} to {day(inv.period.end)} · {STATUS_WORDS[inv.status]}
                        {inv.status === "failed" && inv.failure ? ` · ${inv.failure}` : ""}
                        {inv.dunning === "retrying" && inv.nextAttemptAt ? ` · We'll try again on ${day(inv.nextAttemptAt)}` : ""}
                        {inv.dunning === "unpaid" ? " · Automated sending is paused" : ""}
                      </small>
                    </span>
                    <span className="pg-invoice-actions">
                      <span>{money(inv.totalCents, inv.currency)}</span>
                      {(inv.status === "open" || inv.status === "failed") && data.card && (
                        <button type="button" className="pg-secondary" disabled={busy === "pay"} onClick={() => void run("pay", { action: "pay", id: inv.id }, "Paying now…")}>
                          Pay now
                        </button>
                      )}
                      <a className="pg-secondary" href={`/api/agent/invoice-pdf?id=${encodeURIComponent(inv.id)}`} download>
                        PDF
                      </a>
                      <button type="button" className="pg-secondary" aria-expanded={open === inv.id} onClick={() => setOpen((o) => (o === inv.id ? null : inv.id))}>
                        {open === inv.id ? "Hide" : "Open"}
                      </button>
                    </span>
                    {open === inv.id && <InvoiceDetail id={inv.id} currency={inv.currency} />}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </Frame>
  );
}
