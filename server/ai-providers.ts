import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { featureOn } from "./plans";
import { seal, unseal } from "./connectors";
import { enqueueJob, type Job } from "./jobs";
import { checkAddress } from "./safe-fetch";
import { connectionModels, failingModels, routed, type Connection, type ProviderPolicy } from "./ai-adapters";
import type { AnswerModel, AnswerRequest, ClassifierPort, Served } from "./ai-model";
import { API_KEY, MODEL_NAME, PROVIDERS, PROVIDER_IDS, ANSWER_TIMEOUT_MS, type KeySource, type ProviderId } from "../lib/ai-providers";

/**
 * A workspace's own AI providers (phase 16, step C9d; docs/SECURITY_STEP19.md), on Settings ›
 * Knowledge & AI › AI providers (`workspace.manage`, behind `ai_providers_v1`).
 *
 * - **Connections:** one per provider: its key (sealed with the connector key, bound to the
 *   workspace and provider, never returned: the page shows its last 4 characters), its answering
 *   model, an optional model for classifying, and for a custom endpoint its https base URL.
 * - **Primary and fallback:** with a primary, Zoe answers and classifies with the workspace's
 *   providers (`withWorkspaceModels`), never with Relay's key; the fallback is tried only when the
 *   primary fails. Without one, she uses Relay's AI, as before.
 * - **Save and test:** an `ai.provider.test` job sends one fixed question with one fixed passage
 *   (no customer data) and keeps the result on the connection.
 */
export type ProviderEnvironment = {
  /** RELAY_CONNECTOR_KEY, which seals the keys. */
  key: string;
  /** Tests and the local relay: how requests reach providers (a stub, or allowed hosts). */
  policy?: ProviderPolicy;
};
export const PROVIDERS_FLAG = "ai_providers_v1";
const SEAL = "ai-provider";

type Row = {
  provider: ProviderId;
  key_sealed: string;
  key_hint: string;
  base_url: string | null;
  model: string;
  classifier_model: string | null;
  role: "primary" | "fallback" | null;
  tested_at: string | null;
  test_ok: boolean | null;
  test_detail: string;
  updated_at: string;
};
const invalid = (message: string, field?: string): never => {
  throw new DomainError("INVALID_FIELD", message, 400, field ? { field } : undefined);
};
async function available(db: Sql, w: string) {
  assert(await featureOn(db, w, PROVIDERS_FLAG), "NOT_FOUND", "AI providers aren't available in this workspace.", 404);
}
const rowsOf = async (db: Sql, w: string) =>
  (await db.query<Row>("SELECT * FROM ai_providers WHERE workspace_id=$1", [w])).rows;

/** Whose key Zoe would use now: the workspace's when it has a primary (and the page is on). */
export async function keySourceOf(db: Sql, w: string): Promise<KeySource> {
  if (!(await featureOn(db, w, PROVIDERS_FLAG))) return "relay";
  return (await db.query("SELECT 1 FROM ai_providers WHERE workspace_id=$1 AND role='primary'", [w])).rows.length ? "workspace" : "relay";
}

/** The page: every provider, its connection (never its key), the primary and fallback, and the last week's calls. */
export async function readProviders(db: Sql, w: string, principal: string, relay: { model: string | null } = { model: null }) {
  await authorize(db, w, principal, "workspace.manage");
  await available(db, w);
  const rows = await rowsOf(db, w);
  const week = (
    await db.query<{ provider: string; served: number; failed: number }>(
      `SELECT p.provider,
         (SELECT count(*)::int FROM ai_model_calls c WHERE c.workspace_id=$1 AND c.key_source='workspace' AND c.provider=p.provider AND c.created_at > now() - interval '7 days') AS served,
         (SELECT count(*)::int FROM ai_model_calls c WHERE c.workspace_id=$1 AND c.failover LIKE p.provider || ' %' AND c.created_at > now() - interval '7 days') AS failed
       FROM ai_providers p WHERE p.workspace_id=$1`,
      [w],
    )
  ).rows;
  return {
    providers: PROVIDER_IDS.map((id) => {
      const r = rows.find((x) => x.provider === id);
      const used = week.find((x) => x.provider === id);
      return {
        id,
        ...PROVIDERS[id],
        connection: r
          ? {
              keyHint: r.key_hint,
              baseUrl: r.base_url,
              model: r.model,
              classifierModel: r.classifier_model,
              role: r.role,
              test: r.tested_at ? { at: r.tested_at, ok: !!r.test_ok, detail: r.test_detail } : null,
              updatedAt: r.updated_at,
              lastWeek: { served: used?.served ?? 0, failedOver: used?.failed ?? 0 },
            }
          : null,
      };
    }),
    primary: rows.find((r) => r.role === "primary")?.provider ?? null,
    fallback: rows.find((r) => r.role === "fallback")?.provider ?? null,
    relay,
  };
}

/** A custom endpoint's base URL: https, public, no query; a pasted `/chat/completions` is taken off. */
export function normalizeBaseUrl(raw: unknown, policy: ProviderPolicy = {}) {
  const text = typeof raw === "string" ? raw.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "") : "";
  const bad = () => invalid("Enter the endpoint's https base URL, such as https://api.example.com/v1.", "baseUrl");
  if (!text || text.length > 500) return bad();
  let url: URL;
  try {
    url = checkAddress(text, policy);
  } catch {
    return bad();
  }
  if (url.search || url.hash) return bad();
  return url.toString().replace(/\/+$/, "");
}

/** Save a connection (Save and test also queues its test), test one, remove one, or choose the primary and fallback. */
export async function changeProviders(db: Sql, w: string, principal: string, p: Record<string, unknown>, env?: ProviderEnvironment, relay?: { model: string | null }) {
  const me = await authorize(db, w, principal, "workspace.manage");
  await available(db, w);
  const rows = await rowsOf(db, w);
  const providerOf = (v: unknown) => (PROVIDER_IDS.includes(v as ProviderId) ? (v as ProviderId) : invalid("Choose a provider.", "provider"));
  const test = async (provider: ProviderId) =>
    enqueueJob(db, w, "ai.provider.test", { provider, teammateId: me.id }, { teammateId: me.id });
  if (p.action === "save") {
    const provider = providerOf(p.provider);
    const existing = rows.find((r) => r.provider === provider);
    const key = typeof p.key === "string" ? p.key.trim() : "";
    if (!key && !existing) invalid(`Paste your ${PROVIDERS[provider].name} API key.`, "key");
    if (key && !API_KEY.test(key)) invalid("Paste the API key on one line, without spaces.", "key");
    const model = typeof p.model === "string" ? p.model.trim() : "";
    if (!MODEL_NAME.test(model)) invalid("Enter the model's name exactly as the provider lists it.", "model");
    const classifierModel = typeof p.classifierModel === "string" && p.classifierModel.trim() ? p.classifierModel.trim() : null;
    if (classifierModel && !MODEL_NAME.test(classifierModel)) invalid("Enter the classifying model's name exactly as the provider lists it, or leave it empty.", "classifierModel");
    const baseUrl = provider === "custom" ? normalizeBaseUrl(p.baseUrl, env?.policy) : null;
    assert(env, "CONNECTOR_KEY_MISSING", "Keys can't be stored here: RELAY_CONNECTOR_KEY isn't configured.", 503);
    const sealed = key ? await seal(env.key, w, SEAL, provider, key) : existing!.key_sealed;
    const hint = key ? (key.length >= 12 ? key.slice(-4) : "") : existing!.key_hint;
    // A new key, model or address hasn't been tested.
    const changed = !existing || !!key || existing.model !== model || existing.classifier_model !== classifierModel || existing.base_url !== baseUrl;
    await db.query(
      `INSERT INTO ai_providers(workspace_id,provider,key_sealed,key_hint,base_url,model,classifier_model,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(workspace_id,provider) DO UPDATE SET key_sealed=EXCLUDED.key_sealed,key_hint=EXCLUDED.key_hint,base_url=EXCLUDED.base_url,model=EXCLUDED.model,
         classifier_model=EXCLUDED.classifier_model,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [w, provider, sealed, hint, baseUrl, model, classifierModel, me.id],
    );
    if (changed) await db.query("UPDATE ai_providers SET tested_at=NULL,test_ok=NULL,test_detail='' WHERE workspace_id=$1 AND provider=$2", [w, provider]);
    const jobId = p.test ? await test(provider) : null;
    return { ...(await readProviders(db, w, principal, relay)), ...(jobId ? { jobId } : {}) };
  }
  if (p.action === "test") {
    const provider = providerOf(p.provider);
    if (!rows.some((r) => r.provider === provider)) invalid("Connect the provider first.", "provider");
    assert(env, "CONNECTOR_KEY_MISSING", "Providers can't be tested here: RELAY_CONNECTOR_KEY isn't configured.", 503);
    return { jobId: await test(provider) };
  }
  if (p.action === "remove") {
    const provider = providerOf(p.provider);
    const r = rows.find((x) => x.provider === provider);
    if (!r) invalid("That provider isn't connected.", "provider");
    // A fallback means nothing without its primary.
    if (r!.role === "primary") await db.query("UPDATE ai_providers SET role=NULL WHERE workspace_id=$1 AND role='fallback'", [w]);
    await db.query("DELETE FROM ai_providers WHERE workspace_id=$1 AND provider=$2", [w, provider]);
    return readProviders(db, w, principal, relay);
  }
  if (p.action === "roles") {
    const primary = p.primary === null || p.primary === "" || p.primary === undefined ? null : providerOf(p.primary);
    const fallback = p.fallback === null || p.fallback === "" || p.fallback === undefined ? null : providerOf(p.fallback);
    for (const id of [primary, fallback]) if (id && !rows.some((r) => r.provider === id)) invalid(`Connect ${PROVIDERS[id].name} first.`, id === primary ? "primary" : "fallback");
    if (fallback && !primary) invalid("Choose a primary provider before a fallback.", "fallback");
    if (fallback && fallback === primary) invalid("The fallback must be a different provider from the primary.", "fallback");
    // Only connections whose role changes are touched (each change is audited once): cleared
    // first, so a swap never holds two primaries.
    const wanted = (id: ProviderId) => (id === primary ? "primary" : id === fallback ? "fallback" : null);
    const moving = rows.filter((r) => r.role !== wanted(r.provider));
    for (const r of moving.filter((x) => x.role !== null))
      await db.query("UPDATE ai_providers SET role=NULL WHERE workspace_id=$1 AND provider=$2", [w, r.provider]);
    for (const r of moving.filter((x) => wanted(x.provider) !== null))
      await db.query("UPDATE ai_providers SET role=$3 WHERE workspace_id=$1 AND provider=$2", [w, r.provider, wanted(r.provider)]);
    return readProviders(db, w, principal, relay);
  }
  return invalid("Unknown change to AI providers.");
}

/** A connection with its key read (null: none), or why the key can't be read. */
async function connectionOf(env: ProviderEnvironment | undefined, w: string, r: Row): Promise<Connection | { unreadable: string }> {
  const name = PROVIDERS[r.provider].name;
  if (!env) return { unreadable: `${name}'s key can't be read here: RELAY_CONNECTOR_KEY isn't configured.` };
  try {
    const key = await unseal(env.key, w, SEAL, r.provider, r.key_sealed);
    return { provider: r.provider, key, model: r.model, classifierModel: r.classifier_model, baseUrl: r.base_url };
  } catch {
    return { unreadable: `${name}'s key can't be read. Enter it again on Settings › AI providers.` };
  }
}

/**
 * Zoe's models for this workspace: its primary (and fallback, tried only when the primary fails)
 * when it has one, or the environment's own (Relay's AI) when it hasn't. A key that can't be read
 * fails like a provider that's down: it never switches to Relay's key.
 */
export async function withWorkspaceModels<E extends { model: AnswerModel; classify?: ClassifierPort; providers?: ProviderEnvironment }>(connect: Connect, env: E, w: string): Promise<E> {
  const rows = await tenant(connect, w, async (db) =>
    (await featureOn(db, w, PROVIDERS_FLAG)) ? (await db.query<Row>("SELECT * FROM ai_providers WHERE workspace_id=$1 AND role IS NOT NULL", [w])).rows : [],
  );
  const primary = rows.find((r) => r.role === "primary");
  if (!primary) return env;
  const fallback = rows.find((r) => r.role === "fallback");
  const build = async (r: Row) => {
    const c = await connectionOf(env.providers, w, r);
    return "unreadable" in c ? failingModels(c.unreadable, "workspace", r.provider) : connectionModels(c, env.providers?.policy);
  };
  const first = await build(primary);
  const second = fallback ? await build(fallback) : null;
  return { ...env, model: routed(first.model, second?.model ?? null), classify: routed(first.classify, second?.classify ?? null) };
}

/** The test: one fixed question and passage, never customer data. */
export const TEST_REQUEST: AnswerRequest = {
  question: "When can I reach the support team?",
  history: [],
  passages: [{ id: "p1", recordId: "relay-provider-test", title: "Support hours", heading: "", text: "The support team answers messages Monday to Friday, from 9am to 5pm.", locale: "en" }],
  locale: "en",
  agentName: "Zoe",
};
/** Why a test failed, in words a manager can act on (by status, never the provider's own text). */
export function testFailure(e: unknown): string {
  if (!(e instanceof DomainError)) return "The test couldn't run. Try again.";
  const status = typeof e.details?.status === "number" ? e.details.status : null;
  if (status === 401 || status === 403) return `The provider refused the key (${status}). Check the key, and that it may use this model.`;
  if (status === 404) return "The provider couldn't find the model (404). Check its name.";
  if (status === 429) return "The provider is limiting this key, or its account is out of credit (429).";
  if (status === 400) return "The provider refused the request (400). Check the model's name: it may not be a chat model.";
  if (status && status >= 500) return `The provider had an error (${status}). Try again later.`;
  if (e.code === "MODEL_TIMEOUT") return `The provider didn't answer within ${ANSWER_TIMEOUT_MS / 1000} seconds.`;
  if (e.code === "MODEL_REPLY_INVALID") return "The model answered, but not in the form Zoe needs (one JSON object). Try another model.";
  if (e.code === "MODEL_REFUSED") return "The model declined the test question.";
  return e.message;
}
/** The `ai.provider.test` job: the connection's answering model (and its classifying one, when different). */
export async function runProviderTest(connect: Connect, env: ProviderEnvironment, job: Job) {
  const w = job.workspace_id;
  const provider = String(job.payload.provider ?? "") as ProviderId;
  const row = await tenant(connect, w, async (db) => (await db.query<Row>("SELECT * FROM ai_providers WHERE workspace_id=$1 AND provider=$2", [w, provider])).rows[0]);
  if (!row) return { done: true, result: { ok: false, detail: "That provider isn't connected any more." } };
  const c = await connectionOf(env, w, row);
  let ok = false;
  let detail: string;
  if ("unreadable" in c) detail = c.unreadable;
  else {
    const models = connectionModels(c, env.policy);
    const started = Date.now();
    try {
      let served: Served | null = null;
      const reply = await models.model.answer(TEST_REQUEST, (s) => (served = s));
      const by = (served as Served | null)?.model ?? c.model;
      if (c.classifierModel && c.classifierModel !== c.model)
        await models.classify.classify({ message: "Can I talk to a person, please?", history: [], locale: "en" });
      ok = true;
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      detail =
        reply.kind === "answer" && reply.sentences.some((s) => s.sources.includes("p1"))
          ? `Answered a test question with ${by} in ${seconds} s.`
          : `Connected to ${by}, but it didn't answer the test question from its passage: Zoe may answer less often with this model.`;
    } catch (e) {
      detail = testFailure(e);
    }
  }
  await tenant(connect, w, (db) =>
    db.query("UPDATE ai_providers SET tested_at=now(),test_ok=$3,test_detail=$4 WHERE workspace_id=$1 AND provider=$2", [w, provider, ok, detail]),
  );
  return { done: true, result: { ok, detail } };
}
