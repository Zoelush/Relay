import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";

/**
 * Settings › Security › Links (phase 16, step C7a; docs/SECURITY_STEP11.md), for `security.manage`,
 * behind `security_v1`: trusted and blocked domains for the links customers send. The workspace's
 * own websites are trusted by default. Every click on a customer's link is judged by the server
 * with the lists as they are then.
 */
type Links = { trusted: string[]; blocked: string[]; own: string[]; lookup: string | null };
type Kind = "trusted" | "blocked";

export function LinksPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Links | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Record<Kind, string>>({ trusted: "", blocked: "" });
  const [fieldError, setFieldError] = useState<Partial<Record<Kind, string>>>({});
  const load = useCallback(
    () =>
      api<Links>("links")
        .then(setData)
        .catch((e) => setError(message(e, "Link settings couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const add = async (kind: Kind) => {
    setNotice("");
    setFieldError({});
    try {
      setData(await api<Links>("links", { action: "add", kind, domain: draft[kind] }));
      setNotice(`${draft[kind].trim()} is now ${kind}.`);
      setDraft({ ...draft, [kind]: "" });
    } catch (e) {
      setFieldError({ [kind]: message(e, "That domain couldn't be added.") });
    }
  };
  const remove = async (domain: string) => {
    setNotice("");
    setError("");
    try {
      setData(await api<Links>("links", { action: "remove", domain }));
      setNotice(`${domain} removed.`);
    } catch (e) {
      setError(message(e, "It couldn't be removed."));
    }
  };
  const list = (kind: Kind, title: string, description: string) => (
    <Card title={title} description={description}>
      {data![kind].length ? (
        <ul className="pg-settings-list" aria-label={kind === "trusted" ? "Trusted domains" : "Blocked domains"}>
          {data![kind].map((d) => (
            <li key={d}>
              <span>{d}</span>
              <button type="button" className="pg-wf-link pg-danger-link" aria-label={`Remove ${d}`} onClick={() => void remove(d)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pg-muted">None yet.</p>
      )}
      <form
        className="pg-signin-settings"
        aria-label={kind === "trusted" ? "Add a trusted domain" : "Add a blocked domain"}
        onSubmit={(e) => {
          e.preventDefault();
          void add(kind);
        }}
      >
        <label className="pg-settings-field">
          <span className="pg-settings-label">Domain</span>
          <input
            value={draft[kind]}
            placeholder="example.com"
            spellCheck={false}
            aria-invalid={!!fieldError[kind]}
            onChange={(e) => setDraft({ ...draft, [kind]: e.target.value })}
          />
        </label>
        {fieldError[kind] && (
          <p role="alert" className="pg-attr-error">
            {fieldError[kind]}
          </p>
        )}
        <span className="pg-settings-buttons">
          <button type="submit" className="pg-primary" disabled={!draft[kind].trim()}>
            {kind === "trusted" ? "Trust domain" : "Block domain"}
          </button>
        </span>
      </form>
    </Card>
  );
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
          <Card
            title="How links are checked"
            description="When a teammate opens a link a customer sent, Relay checks it first. Trusted links open straight away. Others show their full address to review. Links that look dangerous need the risk confirmed, and blocked ones don't open."
          >
            <p className="pg-muted">
              {data.lookup
                ? `Links are also checked against a list of known phishing and malware addresses (${data.lookup}).`
                : "Links are checked in Relay only: no outside list of known phishing addresses is set up."}
            </p>
          </Card>
          {list("trusted", "Trusted domains", "Links to these domains and their subdomains open without a review step.")}
          {list("blocked", "Blocked domains", "Links to these domains and their subdomains can't be opened, and teammates can't send them.")}
          <Card title="Your websites" description="Trusted by default: the websites in each brand's messenger settings. Block one to override.">
            {data.own.length ? (
              <ul className="pg-settings-list" aria-label="Your websites">
                {data.own.map((d) => (
                  <li key={d}>
                    <span>{d}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pg-muted">No websites are listed in the messenger settings.</p>
            )}
          </Card>
        </>
      )}
    </Frame>
  );
}
