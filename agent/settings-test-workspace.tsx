import { useCallback, useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";
import { api, chooseWorkspace, chosenWorkspace } from "./api";
import { Card, message } from "./settings-ui";

/**
 * The paired test workspace (docs/TEST_WORKSPACE_PLAN.md), on Settings › General: making one,
 * switching into it, and — while you are in it — what it would have sent to a real person and
 * didn't.
 *
 * The card is the only place the pair is made. Everything it says is the server's: which side you
 * are on, and what the test workspace recorded instead of sending.
 */
type Pair = { here: "production" | "test"; current: { id: string; name: string }; counterpart: string | null } | null;
type Delivery = { id: string; channel: string; address: string; conversationId: string | null; body: string; at: string };

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function TestWorkspaceCard() {
  const [pair, setPair] = useState<Pair>(null);
  const [sent, setSent] = useState<Delivery[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api<Pair>("workspaces")
      .then((p) => {
        setPair(p);
        if (p?.here === "test")
          api<{ deliveries: Delivery[] }>("test-deliveries")
            .then((d) => setSent(d.deliveries))
            .catch(() => {});
      })
      .catch((e) => setError(message(e, "The workspace couldn't be read.")));
  }, []);
  useEffect(load, [load]);
  if (!pair) return null;
  const here = pair.here;
  const go = (id: string) => {
    chooseWorkspace(id === pair.current.id && here === "production" ? "" : id);
    window.location.reload();
  };
  return (
    <Card
      title="Test workspace"
      description="A workspace of your own, with your configuration and made-up customers, where nothing can reach a real person: every message it sends is recorded instead, and it is never billed."
    >
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {here === "test" ? (
        <>
          <p className="pg-settings-value">
            <FlaskConical size={15} aria-hidden="true" /> You are in the test workspace of{" "}
            <strong>{pair.counterpart}</strong>.
          </p>
          <button type="button" className="pg-secondary" onClick={() => go("")}>
            Back to the production workspace
          </button>
          <h4>What it would have sent</h4>
          {sent.length === 0 ? (
            <p className="pg-muted">Nothing yet. Replies, Zoe&apos;s messages and workflows all end up here.</p>
          ) : (
            <ul className="pg-settings-list" aria-label="What it would have sent">
              {sent.map((d) => (
                <li key={d.id}>
                  <span>
                    <strong>
                      {d.channel} · {d.address}
                    </strong>
                    <small className="pg-muted">
                      {when(d.at)} · {d.body.slice(0, 120)}
                    </small>
                  </span>
                  {d.conversationId && (
                    <a className="pg-wf-link" href={`#conversation/${d.conversationId}`}>
                      Open conversation
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : pair.counterpart ? (
        <>
          <p className="pg-settings-value">
            This workspace has a test workspace: <strong>{pair.counterpart}</strong>.
          </p>
          <button type="button" className="pg-secondary" onClick={() => go(pair.counterpart!)}>
            Switch to it
          </button>
        </>
      ) : (
        <>
          <p className="pg-muted">
            It starts with your brands, teams, roles and teammates, your ticket types, SLAs, macros, tags and
            attributes, your workflows, Zoe&apos;s guidance and your help centre — and keeps your plan, so what you
            prove there is true here. A few made-up customers are waiting in its inbox.
          </p>
          <button
            type="button"
            className="pg-primary"
            disabled={busy || chosenWorkspace() !== ""}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await api<{ id: string }>("workspaces", { action: "create_test" });
                load();
              } catch (e) {
                setError(message(e, "The test workspace couldn't be made."));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Making it…" : "Create a test workspace"}
          </button>
        </>
      )}
    </Card>
  );
}
