import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › Security › Data requests (phase 16, step C5a; docs/SECURITY_STEP7.md), for
 * `security.manage`, behind `security_v1`: find one person, export everything about them (a zip,
 * ready to download for seven days) or delete it (confirmed by typing their email, or "delete"),
 * and each request's progress, with the deletion's signed certificate to keep.
 */
type Found = { contactId: string; name: string | null; externalId: string | null; emails: string[]; phones: string[]; conversations: number; takesPartIn: number; mergedContacts: number };
type Request = {
  id: string;
  kind: "export" | "delete";
  state: "queued" | "running" | "done" | "failed";
  label: string | null;
  requestedBy: string | null;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  exportReady: boolean;
  exportExpiresAt: string | null;
  counts: Record<string, number> | null;
  certificate: Record<string, unknown> | null;
};
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const STATES = { queued: "Waiting", running: "Working", done: "Done", failed: "Failed" } as const;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function DataRequestsPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [requests, setRequests] = useState<Request[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const load = useCallback(
    () =>
      api<{ requests: Request[] }>("data-requests")
        .then((r) => setRequests(r.requests))
        .catch((e) => setError(message(e, "Data requests couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // While a request is waiting or working, look again every few seconds.
  const busy = requests?.some((r) => r.state === "queued" || r.state === "running");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [busy, load]);
  const act = async <T,>(p: Record<string, unknown>, fallback: string) => {
    setError("");
    setNotice("");
    try {
      return await api<T>("data-requests", p);
    } catch (e) {
      setError(message(e, fallback));
      return null;
    }
  };
  const start = async (kind: "export" | "delete") => {
    if (!found) return;
    const r = await act<{ requests: Request[] }>({ action: kind, contactId: found.contactId, confirm }, kind === "export" ? "The export couldn't be started." : "The deletion couldn't be started.");
    if (!r) return;
    setRequests(r.requests);
    setNotice(kind === "export" ? "Export started. It appears below when it's ready to download." : "Deletion started. Its certificate appears below when it's done.");
    setFound(null);
    setDeleting(false);
    setConfirm("");
    setQuery("");
  };
  const download = async (r: Request) => {
    const d = await act<{ url: string }>({ action: "download", id: r.id }, "That export couldn't be downloaded.");
    if (d) window.location.assign(d.url);
  };
  const certificate = (r: Request) => {
    const blob = new Blob([JSON.stringify(r.certificate, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `relay-deletion-certificate-${r.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
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
      <Card title="Find a person" description="Export everything about one customer, or delete it, when they ask. Search by email, phone number, external ID or contact ID.">
        <form
          className="pg-invite-form"
          aria-label="Find a person"
          onSubmit={async (e) => {
            e.preventDefault();
            setFound(null);
            setDeleting(false);
            const r = await act<{ found: Found }>({ action: "find", query }, "Nobody could be found.");
            if (r) setFound(r.found);
          }}
        >
          <label>
            Email, phone, external ID or contact ID
            <input required value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <button type="submit" className="pg-secondary">
            Find
          </button>
        </form>
        {found && (
          <section className="pg-dsr-found" aria-label="Person found">
            <h4>{found.name ?? found.emails[0] ?? found.phones[0] ?? "Unnamed person"}</h4>
            <p className="pg-muted">
              {[...found.emails, ...found.phones, found.externalId ? `external ID ${found.externalId}` : ""].filter(Boolean).join(" · ")}
              <br />
              {plural(found.conversations, "conversation")}
              {found.takesPartIn ? `, and part of ${plural(found.takesPartIn, "conversation")} someone else started` : ""}
              {found.mergedContacts ? ` · ${plural(found.mergedContacts, "merged record")}` : ""}
            </p>
            {!deleting ? (
              <span className="pg-settings-buttons">
                <button type="button" className="pg-primary" onClick={() => void start("export")}>
                  Export their data
                </button>
                <button type="button" className="pg-wf-link pg-danger-link" onClick={() => setDeleting(true)}>
                  Delete everything about them…
                </button>
              </span>
            ) : (
              <form
                className="pg-signin-settings"
                aria-label="Confirm deletion"
                onSubmit={(e) => {
                  e.preventDefault();
                  void start("delete");
                }}
              >
                <p>
                  This deletes their profile, every conversation they started (with its messages, files and tickets), their messages in other
                  conversations, and every record of them. <strong>It can’t be undone.</strong> Records others rely on, such as Zoe’s billing ledger and
                  the audit log, keep their counts with nothing that identifies them.
                </p>
                <label className="pg-settings-field">
                  <span className="pg-settings-label">To confirm, type their email address, or the word delete</span>
                  <input required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                </label>
                <span className="pg-settings-buttons">
                  <button type="button" onClick={() => setDeleting(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="pg-primary pg-danger">
                    Delete permanently
                  </button>
                </span>
              </form>
            )}
          </section>
        )}
      </Card>
      <Card title="Requests" description="Exports can be downloaded for seven days. Once a deletion is done, the request keeps only its certificate: nothing about the person.">
        {requests?.length ? (
          <table className="pg-email-records pg-people-table" aria-label="Data requests">
            <thead>
              <tr>
                <th scope="col">Request</th>
                <th scope="col">Person</th>
                <th scope="col">Asked</th>
                <th scope="col">Status</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{r.kind === "export" ? "Export" : "Deletion"}</th>
                  <td>{r.label ?? <span className="pg-muted">{r.kind === "delete" && r.state === "done" ? "Deleted person" : "No longer named"}</span>}</td>
                  <td>
                    {when(r.createdAt)}
                    {r.requestedBy && <small className="pg-muted"> · {r.requestedBy}</small>}
                  </td>
                  <td>
                    {STATES[r.state]}
                    {r.state === "done" && r.counts && r.kind === "export" && (
                      <small className="pg-muted"> · {plural(r.counts.conversations ?? 0, "conversation")}, {plural(r.counts.files ?? 0, "file")}</small>
                    )}
                    {r.state === "done" && r.counts && r.kind === "delete" && (
                      <small className="pg-muted"> · {plural(Object.values(r.counts).reduce((a, b) => a + b, 0), "record")} removed</small>
                    )}
                    {r.error && <small className="pg-attr-error"> · {r.error}</small>}
                  </td>
                  <td>
                    {r.exportReady && (
                      <button type="button" className="pg-wf-link" onClick={() => void download(r)}>
                        Download export
                      </button>
                    )}
                    {r.kind === "delete" && r.state === "done" && r.certificate && (
                      <button type="button" className="pg-wf-link" onClick={() => certificate(r)}>
                        Download certificate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="pg-muted">No requests yet.</p>
        )}
      </Card>
    </Frame>
  );
}
