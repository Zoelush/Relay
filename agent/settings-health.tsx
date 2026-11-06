import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Card, Frame, message, type MenuState, type Page } from "./settings-ui";
import { GROUPS, SEVERITY_LABEL, type CheckResult, type Severity } from "../lib/health-check";
import { DELETION_LABEL, PROCESSORS } from "../lib/processors";
import { KEYS, PROTECTIONS } from "../lib/encryption";

/**
 * Settings › Security › Health check, and › Subprocessors and encryption (phase 16, step C7c;
 * docs/SECURITY_STEP13.md), for `security.manage`, behind `security_v1`. The health check is decided
 * by the server from the workspace's settings on each visit; this page only shows it. The
 * subprocessors and protections are the registries in `lib/processors.ts` and `lib/encryption.ts`.
 */
type Health = { summary: Record<Severity, number>; attention: CheckResult[]; checks: CheckResult[] };

function Row({ c }: { c: CheckResult }) {
  return (
    <li className="pg-health-row">
      <span className="pg-health-badge" data-severity={c.severity}>
        {SEVERITY_LABEL[c.severity]}
      </span>
      <span className="pg-health-text">
        <strong>{c.title}</strong>
        <span>{c.state}</span>
      </span>
      <a className="pg-wf-link" href={c.link} aria-label={`Change ${c.title.toLowerCase()}`}>
        Change
      </a>
    </li>
  );
}

export function HealthCheckPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [data, setData] = useState<Health | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    () =>
      api<Health>("health-check")
        .then(setData)
        .catch((e) => setError(message(e, "The health check couldn't be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const counts = data
    ? (["critical", "recommended", "optional"] as const).filter((s) => data.summary[s]).map((s) => `${data.summary[s]} ${SEVERITY_LABEL[s].toLowerCase()}`)
    : [];
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {data && (
        <>
          <Card title="Needs attention" description="Most important first. Each links to the setting that changes it; this page reflects your settings as they are now.">
            <p role="status" className="pg-health-summary">
              {counts.length ? counts.join(" · ") : "Nothing needs attention."}
            </p>
            {data.attention.length > 0 && (
              <ul className="pg-health-list" aria-label="Needs attention">
                {data.attention.map((c) => (
                  <Row key={c.id} c={c} />
                ))}
              </ul>
            )}
          </Card>
          {GROUPS.map((g) => (
            <Card key={g} title={g}>
              <ul className="pg-health-list" aria-label={g}>
                {data.checks
                  .filter((c) => c.group === g)
                  .map((c) => (
                    <Row key={c.id} c={c} />
                  ))}
              </ul>
            </Card>
          ))}
        </>
      )}
    </Frame>
  );
}

export function TrustPage({ menu, page }: { menu: MenuState; page: Page }) {
  return (
    <Frame menu={menu} page={page}>
      <Card title="Subprocessors" description="Every outside service that receives customer data, what it receives, and what deleting a person does there.">
        <div className="pg-trust-scroll">
          <table className="pg-trust-table" aria-label="Subprocessors">
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Receives</th>
                <th scope="col">When</th>
                <th scope="col">Keeps</th>
                <th scope="col">On deletion</th>
              </tr>
            </thead>
            <tbody>
              {PROCESSORS.map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.name}</th>
                  <td>{p.receives}</td>
                  <td>{p.when}</td>
                  <td>{p.keeps}</td>
                  <td>{DELETION_LABEL[p.deletion]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="How data is protected">
        <dl className="pg-trust-list">
          {PROTECTIONS.map((p) => (
            <div key={p.id}>
              <dt>{p.what}</dt>
              <dd>{p.how}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title="Keys" description="Each is a deployment secret: never in code, configuration or logs.">
        <dl className="pg-trust-list">
          {KEYS.map((k) => (
            <div key={k.name}>
              <dt>
                <code>{k.name}</code>
              </dt>
              <dd>
                {k.protects} <span className="pg-muted">Rotation: {k.rotation}</span>
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    </Frame>
  );
}
