import { assert, DomainError, once, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { zoeAccess } from "./zoe";
import { enqueueJob, type Job } from "./jobs";
import { checkAddress, FetchRefused, safeRequest, type FetchPolicy } from "./safe-fetch";
import {
  DefinitionError,
  SECRET_FOR,
  blankDefinition,
  coerceInputs,
  mapOutputs,
  renderRequest,
  validateDefinition,
  type Definition,
  type Values,
} from "../lib/connector-definition";

/**
 * Data connectors (phase 09, step D1; docs/ACTIONS_STEP1.md), behind `ai_actions_v1`, for those who
 * manage Zoe. A connector is a workspace's HTTP integration: a draft that's edited and tested, and
 * immutable published versions (a conversation keeps the version it started with). Credentials are
 * encrypted with RELAY_CONNECTOR_KEY and never leave the server. Every call goes through
 * `safeRequest` (public https only), is rate limited, and writes an append-only audit row with
 * sensitive inputs redacted and only the mapped values, never the raw response.
 * D3 (docs/ACTIONS_STEP3.md) adds write connectors: Zoe may call one only once a manager turns its
 * writes on, never while the workspace's writes are paused (the kill switch), and a write is only
 * retried with an idempotency key, so one that may have gone through is never sent twice.
 */
export type ConnectorEnvironment = {
  /** RELAY_CONNECTOR_KEY: at least 32 characters. */
  key: string;
  policy?: FetchPolicy;
  /** Waits between retries (tests pass a quick one). */
  sleep?: (ms: number) => Promise<void>;
};
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** What the test console shows of a response body. */
const SHOWN_BODY = 20_000;
const MASK = "••••";

export async function actionsEnabled(db: Sql, w: string) {
  return (
    (
      await db.query(
        "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='ai_actions_v1' AND enabled",
        [w],
      )
    ).rows.length > 0
  );
}
async function access(db: Sql, w: string, principal: string) {
  await zoeAccess(db, w, principal);
  assert(
    await actionsEnabled(db, w),
    "ACTIONS_DISABLED",
    "Data connectors are not enabled for this workspace.",
    404,
  );
  return authorize(db, w, principal, "workspace.manage");
}

/* ------------------------------------------------------------------------------------------ */
/* Secrets                                                                                     */

const encoder = new TextEncoder();
async function aesKey(master: string) {
  assert(
    typeof master === "string" && master.length >= 32,
    "CONNECTOR_KEY_MISSING",
    "Connector credentials can't be stored here: RELAY_CONNECTOR_KEY isn't configured.",
    503,
  );
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", encoder.encode(master)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** Encrypted, bound to the workspace, connector and what it is. */
export async function seal(master: string, w: string, connectorId: string, name: string, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(JSON.stringify([w, connectorId, name])) },
    await aesKey(master),
    encoder.encode(value),
  );
  return b64(iv) + "." + b64(new Uint8Array(data));
}
async function open(master: string, w: string, connectorId: string, name: string, sealed: string) {
  const [iv, data] = sealed.split(".");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv), additionalData: encoder.encode(JSON.stringify([w, connectorId, name])) },
      await aesKey(master),
      unb64(data),
    ),
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Context                                                                                     */

/** The values context inputs come from, for a conversation. */
export async function connectorContext(db: Sql, w: string, conversationId: string) {
  const row = (
    await db.query<{ name: string | null; external_id: string | null; email: string | null; kind: string | null }>(
      `SELECT k.name,k.external_id,i.kind,
         (SELECT e.email FROM contact_emails e WHERE e.workspace_id=k.workspace_id AND e.contact_id=k.id ORDER BY e.verified DESC,e.email LIMIT 1) AS email
       FROM conversations c
       LEFT JOIN identities i ON i.workspace_id=c.workspace_id AND i.id=c.primary_identity_id
       LEFT JOIN identity_contact_mappings m ON m.workspace_id=c.workspace_id AND m.identity_id=c.primary_identity_id
       LEFT JOIN contacts k ON k.workspace_id=m.workspace_id AND k.id=m.contact_id
       WHERE c.workspace_id=$1 AND c.id=$2`,
      [w, conversationId],
    )
  ).rows[0];
  assert(row, "CONVERSATION_NOT_FOUND", "Conversation unavailable.", 404);
  const out: Record<string, string> = { "conversation.id": conversationId };
  if (row.name) out["contact.name"] = row.name;
  if (row.email) out["contact.email"] = row.email;
  // Only a signed-in customer's user ID: one a visitor typed would be anyone's.
  if (row.external_id && row.kind === "user") out["contact.external_id"] = row.external_id;
  return out;
}

/** The version a conversation uses: the one it first used, or the live one (then kept). */
export async function pinnedVersion(db: Sql, w: string, connectorId: string, conversationId: string) {
  const pinned = (
    await db.query<{ version: number }>(
      "SELECT version FROM ai_connector_pins WHERE workspace_id=$1 AND conversation_id=$2 AND connector_id=$3",
      [w, conversationId, connectorId],
    )
  ).rows[0];
  if (pinned) return pinned.version;
  const live = (
    await db.query<{ live_version: number | null }>(
      "SELECT live_version FROM ai_connectors WHERE workspace_id=$1 AND id=$2 AND NOT archived",
      [w, connectorId],
    )
  ).rows[0]?.live_version;
  if (!live) return null;
  await db.query(
    "INSERT INTO ai_connector_pins(workspace_id,conversation_id,connector_id,version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [w, conversationId, connectorId, live],
  );
  return live;
}

/* ------------------------------------------------------------------------------------------ */
/* Running                                                                                     */

export type CallResult =
  | "ok"
  | "http_error"
  | "timeout"
  | "refused"
  | "invalid_input"
  | "invalid_response"
  | "rate_limited"
  | "auth_failed"
  | "unreachable";
export type Call = {
  callId: string;
  result: CallResult;
  status: number | null;
  attempts: number;
  durationMs: number;
  outputs: Record<string, unknown>;
  error: string;
  /** The test console only: exactly what was sent and received, with secrets masked. */
  request?: { method: string; url: string; headers: Record<string, string>; body: string | null };
  response?: { status: number; contentType: string; body: string; truncated: boolean };
};

class Stop extends Error {
  constructor(
    public result: CallResult,
    message: string,
    public status: number | null = null,
  ) {
    super(message);
  }
}

/**
 * One call: the draft (the test console) or a version, with values for its inputs (context inputs
 * from `connectorContext` when there's a conversation). Never throws for the remote side's
 * failures: the result says what happened, and the audit row records it.
 */
export async function runConnector(
  connect: Connect,
  env: ConnectorEnvironment,
  w: string,
  run: {
    connectorId: string;
    version: number | "draft";
    values: Record<string, unknown>;
    source: "test" | "agent";
    invokedBy: string;
    conversationId?: string;
    /** Return the masked request and response (the test console). */
    show?: boolean;
    /** D3: the approval a write runs under, and its idempotency key (the same on every attempt). */
    approvalId?: string;
    idempotencyKey?: string;
  },
): Promise<Call> {
  const started = Date.now();
  const callId = crypto.randomUUID();
  const sleep = env.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  // Read what's needed, and count the call against the rate limit, before any network.
  const prepared = await tenant(connect, w, async (db) => {
    const c = (
      await db.query<{ draft: Definition; archived: boolean; writes_enabled: boolean; paused: boolean }>(
        `SELECT c.draft,c.archived,c.writes_enabled,
           COALESCE((SELECT a.writes_paused FROM ai_agents a WHERE a.workspace_id=c.workspace_id ORDER BY a.id LIMIT 1),false) AS paused
         FROM ai_connectors c WHERE c.workspace_id=$1 AND c.id=$2`,
        [w, run.connectorId],
      )
    ).rows[0];
    assert(c && !c.archived, "CONNECTOR_NOT_FOUND", "That connector isn't available.", 404);
    const def =
      run.version === "draft"
        ? c.draft
        : (
            await db.query<{ definition: Definition }>(
              "SELECT definition FROM ai_connector_versions WHERE workspace_id=$1 AND connector_id=$2 AND version=$3",
              [w, run.connectorId, run.version],
            )
          ).rows[0]?.definition;
    assert(def, "CONNECTOR_NOT_FOUND", "That connector version isn't available.", 404);
    const context = run.conversationId ? await connectorContext(db, w, run.conversationId) : {};
    const secrets = new Map(
      (
        await db.query<{ name: string; wrapped: string }>(
          "SELECT name,wrapped FROM ai_connector_secrets WHERE workspace_id=$1 AND connector_id=$2",
          [w, run.connectorId],
        )
      ).rows.map((r) => [r.name, r.wrapped]),
    );
    const token = (
      await db.query<{ wrapped: string }>(
        "SELECT wrapped FROM ai_connector_tokens WHERE workspace_id=$1 AND connector_id=$2 AND expires_at>now()+interval '30 seconds'",
        [w, run.connectorId],
      )
    ).rows[0]?.wrapped;
    const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
    const calls = (
      await db.query<{ calls: number }>(
        `INSERT INTO ai_connector_rate(workspace_id,connector_id,minute,calls) VALUES($1,$2,$3,1)
         ON CONFLICT(workspace_id,connector_id,minute) DO UPDATE SET calls=ai_connector_rate.calls+1 RETURNING calls`,
        [w, run.connectorId, minute],
      )
    ).rows[0].calls;
    await db.query("DELETE FROM ai_connector_rate WHERE workspace_id=$1 AND minute<$2", [
      w,
      new Date(Date.now() - 10 * 60_000).toISOString(),
    ]);
    return { def, context, secrets, token, overLimit: calls > def.rateLimit, writesEnabled: c.writes_enabled, paused: c.paused };
  });
  const { def } = prepared;
  const known: string[] = [];
  let values: Values = {};
  let request: Call["request"];
  let response: Call["response"];
  let status: number | null = null;
  let attempts = 0;
  let outputs: Record<string, unknown> = {};
  let result: CallResult = "ok";
  let error = "";
  let newToken: { value: string; expiresAt: Date } | null = null;
  const mask = (s: string) => known.reduce((t, k) => (k ? t.split(k).join(MASK) : t), s);
  const write = def.access === "write";
  // A write is retried only when the service can tell the attempts are one (an idempotency key).
  const retries = write && !(def.idempotencyHeader && run.idempotencyKey) ? 0 : def.retries;
  try {
    if (write && prepared.paused) throw new Stop("refused", "Write actions are paused for this workspace.");
    if (write && run.source === "agent" && !prepared.writesEnabled)
      throw new Stop("refused", "Writes aren't turned on for this connector.");
    if (prepared.overLimit) throw new Stop("rate_limited", `Over its limit of ${def.rateLimit} calls a minute.`);
    try {
      // Context inputs come only from the conversation (the test console gives sample values for
      // them); the rest are given.
      const given: Record<string, unknown> = {};
      for (const i of def.inputs)
        given[i.name] =
          i.source === "customer" || run.source === "test" ? run.values[i.name] : prepared.context[i.source];
      values = coerceInputs(def, given);
    } catch (e) {
      if (e instanceof DefinitionError) throw new Stop("invalid_input", e.message);
      throw e;
    }
    const secretName = SECRET_FOR[def.auth.type];
    const secret = secretName
      ? prepared.secrets.get(secretName)
        ? await open(env.key, w, run.connectorId, secretName, prepared.secrets.get(secretName)!)
        : null
      : null;
    if (secretName && !secret) throw new Stop("auth_failed", "Its credential hasn't been set.");
    if (secret) known.push(secret);
    let token = prepared.token ? await open(env.key, w, run.connectorId, "token:oauth", prepared.token) : null;
    const fetchToken = async () => {
      const a = def.auth as Extract<Definition["auth"], { type: "oauth_client_credentials" }>;
      const form = new URLSearchParams({ grant_type: "client_credentials", client_id: a.clientId, client_secret: secret! });
      if (a.scope) form.set("scope", a.scope);
      let got;
      try {
        got = await safeRequest(
          a.tokenUrl,
          env.policy ?? {},
          { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form.toString() },
          { maxBytes: 64 * 1024, timeoutMs: def.timeoutMs },
        );
      } catch (e) {
        throw new Stop("auth_failed", `The token request failed (${e instanceof FetchRefused ? e.code : "error"}).`);
      }
      let parsed: { access_token?: unknown; expires_in?: unknown };
      try {
        parsed = JSON.parse(got.body);
      } catch {
        parsed = {};
      }
      if (got.status !== 200 || typeof parsed.access_token !== "string" || !parsed.access_token)
        throw new Stop("auth_failed", `The token request was refused (${got.status}).`, got.status);
      const seconds = Number(parsed.expires_in);
      newToken = {
        value: parsed.access_token,
        expiresAt: new Date(Date.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 86_400) : 3600) * 1000),
      };
      return parsed.access_token;
    };
    if (def.auth.type === "oauth_client_credentials" && !token) token = await fetchToken();
    const build = () => {
      const r = renderRequest(def, values);
      if (write && def.idempotencyHeader && run.idempotencyKey) r.headers[def.idempotencyHeader] = run.idempotencyKey;
      if (def.auth.type === "api_key") r.headers[def.auth.header] = secret!;
      if (def.auth.type === "bearer") r.headers.authorization = "Bearer " + secret;
      if (def.auth.type === "oauth_client_credentials") r.headers.authorization = "Bearer " + token;
      return r;
    };
    let refreshed = false;
    for (;;) {
      attempts++;
      const r = build();
      if (token) known.push(token);
      if (run.show)
        request = {
          method: r.method,
          url: mask(r.url),
          headers: Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, mask(v)])),
          body: r.body === undefined ? null : mask(r.body),
        };
      let got;
      try {
        checkAddress(r.url, env.policy ?? {});
        got = await safeRequest(r.url, env.policy ?? {}, { method: r.method, headers: r.headers, body: r.body }, {
          maxBytes: MAX_RESPONSE_BYTES,
          timeoutMs: def.timeoutMs,
        });
      } catch (e) {
        const code = e instanceof FetchRefused ? e.code : "UNREACHABLE";
        const stop =
          code === "TIMEOUT"
            ? new Stop("timeout", `No answer within ${def.timeoutMs / 1000} seconds${write ? "; it may have gone through" : ""}.`)
            : code === "UNREACHABLE"
              ? new Stop("unreachable", "The address couldn't be reached.")
              : code === "TOO_LARGE"
                ? new Stop("invalid_response", "The response was larger than 1 MB.")
                : new Stop("refused", "Relay only calls public https addresses.");
        if ((stop.result === "timeout" || stop.result === "unreachable") && attempts <= retries) {
          await sleep(250 * 2 ** (attempts - 1));
          continue;
        }
        throw stop;
      }
      status = got.status;
      if (run.show)
        response = {
          status: got.status,
          contentType: got.headers.get("content-type") ?? "",
          body: mask(got.body.slice(0, SHOWN_BODY)),
          truncated: got.body.length > SHOWN_BODY,
        };
      if (got.status === 401 && def.auth.type === "oauth_client_credentials" && !refreshed) {
        // An expired or revoked token: fetch a new one, once.
        refreshed = true;
        token = await fetchToken();
        continue;
      }
      if ((got.status === 429 || got.status >= 500) && attempts <= retries) {
        await sleep(250 * 2 ** (attempts - 1));
        continue;
      }
      if (got.status === 401 || got.status === 403)
        throw new Stop("auth_failed", `The service refused the credentials (${got.status}).`, got.status);
      if (got.status < 200 || got.status >= 300)
        throw new Stop("http_error", `The service answered ${got.status}.`, got.status);
      let data: unknown;
      try {
        data = got.body ? JSON.parse(got.body) : null;
      } catch {
        throw new Stop("invalid_response", "The response wasn't JSON.", got.status);
      }
      try {
        outputs = mapOutputs(def, data);
      } catch (e) {
        if (e instanceof DefinitionError) throw new Stop("invalid_response", e.message, got.status);
        throw e;
      }
      break;
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    result = e.result;
    error = mask(e.message);
    if (e.status !== null) status = e.status;
  }
  const durationMs = Date.now() - started;
  // The audit: sensitive inputs and outputs redacted, never the raw response.
  const redactedInputs = Object.fromEntries(
    def.inputs.filter((i) => i.name in values).map((i) => [i.name, i.sensitive ? "[redacted]" : values[i.name]]),
  );
  const redactedOutputs = Object.fromEntries(
    def.outputs.map((o) => [o.name, o.sensitive && outputs[o.name] !== null && outputs[o.name] !== undefined ? "[redacted]" : (outputs[o.name] ?? null)]),
  );
  let auditUrl = def.baseUrl + def.path;
  try {
    auditUrl = mask(renderRequest(def, values).url);
  } catch {
    // Inputs that never validated: the template, not a filled address.
  }
  await tenant(connect, w, async (db) => {
    await db.query(
      `INSERT INTO ai_connector_calls(workspace_id,id,connector_id,version,draft,source,invoked_by,conversation_id,method,url,inputs,outputs,status,attempts,duration_ms,result,error,approval_id,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        w,
        callId,
        run.connectorId,
        run.version === "draft" ? null : run.version,
        run.version === "draft",
        run.source,
        run.invokedBy,
        run.conversationId ?? null,
        def.method,
        // Sensitive inputs never reach the audit, not even inside the address.
        def.inputs.filter((i) => i.sensitive && i.name in values).reduce((u, i) => u.split(encodeURIComponent(String(values[i.name]))).join("[redacted]").split(String(values[i.name])).join("[redacted]"), auditUrl),
        JSON.stringify(redactedInputs),
        JSON.stringify(redactedOutputs),
        status,
        Math.max(1, attempts),
        durationMs,
        result,
        error,
        run.approvalId ?? null,
        write ? (run.idempotencyKey ?? null) : null,
      ],
    );
    const t = newToken as { value: string; expiresAt: Date } | null;
    if (t)
      await db.query(
        `INSERT INTO ai_connector_tokens(workspace_id,connector_id,wrapped,expires_at) VALUES($1,$2,$3,$4)
         ON CONFLICT(workspace_id,connector_id) DO UPDATE SET wrapped=EXCLUDED.wrapped,expires_at=EXCLUDED.expires_at`,
        [w, run.connectorId, await seal(env.key, w, run.connectorId, "token:oauth", t.value), t.expiresAt.toISOString()],
      );
  });
  return {
    callId,
    result,
    status,
    attempts: Math.max(1, attempts),
    durationMs,
    outputs: result === "ok" ? outputs : {},
    error,
    ...(run.show ? { request, response } : {}),
  };
}

/** The test console's job: the draft, with the sample values a teammate typed. */
export async function runConnectorTest(connect: Connect, env: ConnectorEnvironment, job: Job) {
  const p = job.payload as { connectorId: string; values: Record<string, unknown>; teammateId: string };
  const call = await runConnector(connect, env, job.workspace_id, {
    connectorId: p.connectorId,
    version: "draft",
    values: p.values,
    source: "test",
    invokedBy: p.teammateId,
    show: true,
    idempotencyKey: crypto.randomUUID(),
  });
  return { done: true, result: call as unknown as Record<string, unknown> };
}

/* ------------------------------------------------------------------------------------------ */
/* Reading                                                                                     */

type Row = {
  id: string;
  name: string;
  access: string;
  writes_enabled: boolean;
  writes_enabled_name: string | null;
  writes_enabled_at: string | null;
  draft: Definition;
  live_version: number | null;
  live: Definition | null;
  version: string;
  updated_at: string;
};
const ROW = `c.id,c.name,c.access,c.writes_enabled,c.writes_enabled_at,
  (SELECT t.name FROM teammates t WHERE t.workspace_id=c.workspace_id AND t.id=c.writes_enabled_by) AS writes_enabled_name,
  c.draft,c.live_version,c.version::text AS version,c.updated_at,
  (SELECT v.definition FROM ai_connector_versions v WHERE v.workspace_id=c.workspace_id AND v.connector_id=c.id AND v.version=c.live_version) AS live
  FROM ai_connectors c`;
async function secretsOf(db: Sql, w: string, id: string) {
  return (
    await db.query<{ name: string; hint: string; updated_at: string }>(
      "SELECT name,hint,updated_at FROM ai_connector_secrets WHERE workspace_id=$1 AND connector_id=$2 ORDER BY name",
      [w, id],
    )
  ).rows.map((s) => ({ name: s.name, hint: s.hint, updatedAt: new Date(s.updated_at).toISOString() }));
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Zoe › Train › Actions: her connectors. */
/** The workspace's kill switch for write actions (D3). */
async function pausedState(db: Sql, w: string) {
  const r = (
    await db.query<{ writes_paused: boolean; name: string | null; writes_paused_at: string | null }>(
      `SELECT a.writes_paused,a.writes_paused_at,(SELECT t.name FROM teammates t WHERE t.workspace_id=a.workspace_id AND t.id=a.writes_paused_by) AS name
       FROM ai_agents a WHERE a.workspace_id=$1 ORDER BY a.id LIMIT 1`,
      [w],
    )
  ).rows[0];
  return { paused: !!r?.writes_paused, by: r?.name ?? null, at: r?.writes_paused_at ? new Date(r.writes_paused_at).toISOString() : null };
}

export async function readConnectors(db: Sql, w: string, principal: string) {
  await access(db, w, principal);
  const rows = (await db.query<Row>(`SELECT ${ROW} WHERE c.workspace_id=$1 AND NOT c.archived ORDER BY lower(c.name),c.id`, [w])).rows;
  const last = new Map(
    (
      await db.query<{ connector_id: string; result: string; created_at: string }>(
        `SELECT DISTINCT ON (connector_id) connector_id,result,created_at FROM ai_connector_calls
         WHERE workspace_id=$1 ORDER BY connector_id,created_at DESC`,
        [w],
      )
    ).rows.map((r) => [r.connector_id, { result: r.result, at: new Date(r.created_at).toISOString() }]),
  );
  return {
    writes: await pausedState(db, w),
    connectors: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.draft.description,
      access: r.access,
      writesEnabled: r.writes_enabled,
      method: r.draft.method,
      liveVersion: r.live_version,
      changed: !r.live || !same(r.draft, r.live),
      lastCall: last.get(r.id) ?? null,
    })),
  };
}

/** One connector: its draft, versions, which credentials are set, and its recent calls. */
export async function readConnector(db: Sql, w: string, principal: string, id: string) {
  await access(db, w, principal);
  const r = (await db.query<Row>(`SELECT ${ROW} WHERE c.workspace_id=$1 AND c.id=$2 AND NOT c.archived`, [w, id])).rows[0];
  assert(r, "CONNECTOR_NOT_FOUND", "That connector isn't available.", 404);
  const versions = (
    await db.query<{ version: number; published_at: string; name: string | null }>(
      `SELECT v.version,v.published_at,t.name FROM ai_connector_versions v
       LEFT JOIN teammates t ON t.workspace_id=v.workspace_id AND t.id=v.published_by
       WHERE v.workspace_id=$1 AND v.connector_id=$2 ORDER BY v.version DESC LIMIT 20`,
      [w, id],
    )
  ).rows.map((v) => ({ version: v.version, publishedAt: new Date(v.published_at).toISOString(), by: v.name }));
  const calls = (
    await db.query<{
      id: string;
      version: number | null;
      draft: boolean;
      source: string;
      conversation_id: string | null;
      inputs: Record<string, unknown>;
      outputs: Record<string, unknown>;
      status: number | null;
      duration_ms: number;
      result: string;
      error: string;
      created_at: string;
      name: string | null;
    }>(
      `SELECT k.id,k.version,k.draft,k.source,k.conversation_id,k.inputs,k.outputs,k.status,k.duration_ms,k.result,k.error,k.created_at,t.name
       FROM ai_connector_calls k LEFT JOIN teammates t ON t.workspace_id=k.workspace_id AND t.id=k.invoked_by
       WHERE k.workspace_id=$1 AND k.connector_id=$2 ORDER BY k.created_at DESC,k.id LIMIT 20`,
      [w, id],
    )
  ).rows.map((k) => ({
    id: k.id,
    version: k.version,
    draft: k.draft,
    source: k.source,
    by: k.source === "agent" ? "Zoe" : (k.name ?? "A teammate"),
    conversationId: k.conversation_id,
    inputs: k.inputs,
    outputs: k.outputs,
    status: k.status,
    durationMs: k.duration_ms,
    result: k.result,
    error: k.error,
    at: new Date(k.created_at).toISOString(),
  }));
  return {
    connector: {
      id: r.id,
      name: r.name,
      access: r.access,
      version: r.version,
      definition: r.draft,
      liveVersion: r.live_version,
      changed: !r.live || !same(r.draft, r.live),
      secrets: await secretsOf(db, w, id),
      // D3: whether Zoe may use its writes, and who turned them on.
      writes: { enabled: r.writes_enabled, by: r.writes_enabled_name, at: r.writes_enabled_at ? new Date(r.writes_enabled_at).toISOString() : null },
      liveAccess: r.live?.access ?? (r.live ? "read" : null),
    },
    paused: (await pausedState(db, w)).paused,
    versions,
    calls,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Changes                                                                                     */

const invalid = (message: string): never => {
  throw new DomainError("INVALID_CONNECTOR", message, 400);
};
function definition(raw: unknown, policy: FetchPolicy): Definition {
  let def: Definition;
  try {
    def = validateDefinition(raw);
  } catch (e) {
    if (e instanceof DefinitionError) return invalid(e.message);
    throw e;
  }
  // Only addresses Relay may call (public https), checked again on every call.
  for (const [address, what] of [
    [def.baseUrl + "/", "the base address"],
    ...(def.auth.type === "oauth_client_credentials" ? [[def.auth.tokenUrl, "the token address"]] : []),
  ])
    try {
      checkAddress(address, policy);
    } catch {
      invalid(`Relay only calls public https addresses; ${what} isn't one.`);
    }
  return def;
}
const nameOf = (v: unknown) => {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!s || s.length > 60 || /[\x00-\x1f]/.test(s)) invalid("Name the connector, in up to 60 characters.");
  return s;
};

/**
 * One change, idempotent by key: `create`, `save` the draft (by version), `publish` it as the next
 * version, `archive`, set a `secret`, or `test` the draft (a job; poll it).
 */
export async function changeConnector(
  db: Sql,
  w: string,
  principal: string,
  key: string,
  p: Record<string, unknown>,
  env: ConnectorEnvironment | undefined,
) {
  const t = await access(db, w, principal);
  const policy = env?.policy ?? {};
  return once(db, w, "zoe-connector:" + principal, key, p, async () => {
    const taken = async (name: string, except = "") =>
      (
        await db.query(
          "SELECT 1 FROM ai_connectors WHERE workspace_id=$1 AND lower(name)=lower($2) AND NOT archived AND id<>$3",
          [w, name, except],
        )
      ).rows.length > 0;
    if (p.action === "pause") {
      // D3: the kill switch, for every write action in the workspace, at once.
      if (typeof p.paused !== "boolean") invalid("Pause or resume write actions.");
      await db.query(
        `UPDATE ai_agents SET writes_paused=$2,writes_paused_by=$3,writes_paused_at=now(),updated_at=now() WHERE workspace_id=$1`,
        [w, p.paused, t.id],
      );
      return readConnectors(db, w, principal);
    }
    if (p.action === "create") {
      const name = nameOf(p.name);
      if (await taken(name)) invalid(`There's already a connector called ${name}.`);
      const id = crypto.randomUUID();
      await db.query(
        "INSERT INTO ai_connectors(workspace_id,id,name,draft,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5)",
        [w, id, name, JSON.stringify(blankDefinition()), t.id],
      );
      return readConnector(db, w, principal, id);
    }
    const id = String(p.id ?? "");
    const row = (
      await db.query<{ version: string; draft: Definition; live_version: number | null }>(
        "SELECT version::text AS version,draft,live_version FROM ai_connectors WHERE workspace_id=$1 AND id=$2 AND NOT archived",
        [w, id],
      )
    ).rows[0];
    assert(row, "CONNECTOR_NOT_FOUND", "That connector isn't available.", 404);
    const current = () => {
      if (String(p.version ?? "") !== row.version)
        throw new DomainError("CONNECTOR_CHANGED", "Someone else changed this connector. Reload to see it.", 409);
    };
    if (p.action === "save") {
      current();
      const name = nameOf(p.name);
      if (await taken(name, id)) invalid(`There's already a connector called ${name}.`);
      const def = definition(p.definition, policy);
      await db.query(
        `UPDATE ai_connectors SET name=$3,draft=$4,version=version+1,updated_by=$5,updated_at=now(),
           access=CASE WHEN live_version IS NULL THEN $6 ELSE access END
         WHERE workspace_id=$1 AND id=$2`,
        [w, id, name, JSON.stringify(def), t.id, def.access],
      );
      return readConnector(db, w, principal, id);
    }
    if (p.action === "publish") {
      current();
      const def = definition(row.draft, policy);
      const secret = SECRET_FOR[def.auth.type];
      if (
        secret &&
        !(await db.query("SELECT 1 FROM ai_connector_secrets WHERE workspace_id=$1 AND connector_id=$2 AND name=$3", [w, id, secret]))
          .rows.length
      )
        invalid("Set its credential before publishing.");
      const version =
        ((
          await db.query<{ v: number | null }>(
            "SELECT max(version) AS v FROM ai_connector_versions WHERE workspace_id=$1 AND connector_id=$2",
            [w, id],
          )
        ).rows[0].v ?? 0) + 1;
      await db.query(
        "INSERT INTO ai_connector_versions(workspace_id,connector_id,version,definition,published_by) VALUES($1,$2,$3,$4,$5)",
        [w, id, version, JSON.stringify(def), t.id],
      );
      // The live version decides its access; a connector published as read has its writes off.
      await db.query(
        `UPDATE ai_connectors SET live_version=$3,access=$5,writes_enabled=writes_enabled AND $5='write',version=version+1,updated_by=$4,updated_at=now()
         WHERE workspace_id=$1 AND id=$2`,
        [w, id, version, t.id, def.access],
      );
      return readConnector(db, w, principal, id);
    }
    if (p.action === "writes") {
      // D3: Zoe may use a write connector only after a manager turns its writes on, past a warning.
      current();
      if (typeof p.enabled !== "boolean") invalid("Turn writes on or off.");
      if (p.enabled) {
        if (p.acknowledged !== true) invalid("Confirm that Zoe may change things in this service.");
        const live = (
          await db.query<{ access: string }>(
            "SELECT definition->>'access' AS access FROM ai_connector_versions WHERE workspace_id=$1 AND connector_id=$2 AND version=$3",
            [w, id, row.live_version],
          )
        ).rows[0];
        if (live?.access !== "write") invalid("Publish it as a write connector first.");
      }
      await db.query(
        `UPDATE ai_connectors SET writes_enabled=$3,writes_enabled_by=CASE WHEN $3 THEN $4 ELSE writes_enabled_by END,
           writes_enabled_at=CASE WHEN $3 THEN now() ELSE writes_enabled_at END,version=version+1,updated_by=$4,updated_at=now()
         WHERE workspace_id=$1 AND id=$2`,
        [w, id, p.enabled, t.id],
      );
      return readConnector(db, w, principal, id);
    }
    if (p.action === "archive") {
      current();
      await db.query(
        "UPDATE ai_connectors SET archived=true,version=version+1,updated_by=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [w, id, t.id],
      );
      await db.query("DELETE FROM ai_connector_tokens WHERE workspace_id=$1 AND connector_id=$2", [w, id]);
      return readConnectors(db, w, principal);
    }
    if (p.action === "secret") {
      const name = String(p.name ?? "");
      if (!["api_key", "token", "client_secret"].includes(name)) invalid("Choose which credential to set.");
      const value = typeof p.value === "string" ? p.value.trim() : "";
      if (!value || value.length > 4000 || /[\r\n\x00]/.test(value)) invalid("Paste the credential, on one line.");
      assert(env, "CONNECTOR_KEY_MISSING", "Connector credentials can't be stored here: RELAY_CONNECTOR_KEY isn't configured.", 503);
      await db.query(
        `INSERT INTO ai_connector_secrets(workspace_id,connector_id,name,wrapped,hint,updated_by) VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(workspace_id,connector_id,name) DO UPDATE SET wrapped=EXCLUDED.wrapped,hint=EXCLUDED.hint,updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [w, id, name, await seal(env.key, w, id, name, value), value.length >= 12 ? value.slice(-4) : "", t.id],
      );
      // A new client secret means a new token.
      await db.query("DELETE FROM ai_connector_tokens WHERE workspace_id=$1 AND connector_id=$2", [w, id]);
      return readConnector(db, w, principal, id);
    }
    if (p.action === "test") {
      assert(env, "CONNECTOR_KEY_MISSING", "Connectors can't run here: RELAY_CONNECTOR_KEY isn't configured.", 503);
      const values = p.values && typeof p.values === "object" ? (p.values as Record<string, unknown>) : {};
      if (Object.keys(values).length > 20 || JSON.stringify(values).length > 20_000) invalid("Give fewer sample values.");
      const jobId = await enqueueJob(db, w, "connector.test", { connectorId: id, values, teammateId: t.id }, { teammateId: t.id });
      return { jobId };
    }
    return invalid("Unknown connector change.");
  });
}
